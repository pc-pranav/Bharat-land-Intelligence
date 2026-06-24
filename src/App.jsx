import { useState, useEffect, useRef, useMemo, Component } from "react";
import GoogleMapView from "./components/GoogleMapView";

// API endpoint: in this Claude.ai artifact preview, call Anthropic directly.
// When deployed standalone (e.g. on Vercel), this is automatically replaced with
// "/api/claude" so requests route through the serverless proxy — which keeps your
// API key server-side AND adds response caching (see DEPLOY.md and lib/cache.js).
// To deploy: change the line below to const API_ENDPOINT = "/api/claude";

// ── Runtime data loader ────────────────────────────────────────────────────
// Fetches ETL pipeline outputs from /data/ at runtime. The app boots with
// hardcoded seed data (instant, no network dependency), then silently
// upgrades to ETL-computed data when the JSON files are available.
// This means:
//   • First load is always fast — no spinner waiting for data
//   • After ETL runs and files are deployed, scores update automatically
//   • If fetch fails (Claude sandbox, network issue) — seed data still works
//
// Files served from:
//   Vercel deployment: /public/data/*.json  (static file serving)
//   Claude artifact:   fetch will fail gracefully, seed data used
//
function useAppData() {
  const [dataReady, setDataReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadETLData() {
      // Load REGION_CLUSTERS — ETL-computed proximity scores
      try {
        const rcRes = await fetch('/data/REGION_CLUSTERS.json');
        if (rcRes.ok) {
          const rc = await rcRes.json();
          if (rc.clusters && !cancelled) {
            // Merge ETL scores into the mutable REGION_CLUSTERS object
            // Only update scores — preserve any entries in seed not in ETL
            Object.entries(rc.clusters).forEach(([state, regions]) => {
              REGION_CLUSTERS[state] = regions.map(r => ({
                name:  r.name,
                lat:   r.lat,
                lng:   r.lng,
                score: r.score,
              }));
            });
            console.log('[ETL] Loaded REGION_CLUSTERS:', 
              Object.values(rc.clusters).flat().length, 'regions from ETL pipeline');
            setDataReady(true);
          }
        }
      } catch (e) {
        // Silent — seed data already loaded, ETL data is optional upgrade
        console.log('[ETL] REGION_CLUSTERS not available, using seed data');
      }

      // Load metro stations — ETL-cleaned station list
      try {
        const msRes = await fetch('/data/metro_stations_flat.json');
        if (msRes.ok) {
          const ms = await msRes.json();
          if (ms.stations?.length > 0 && !cancelled) {
            // Replace the global station array in place
            INDIA_METRO_STATIONS.length = 0;
            ms.stations.forEach(s => INDIA_METRO_STATIONS.push(s));
            console.log('[ETL] Loaded metro stations:', ms.stations.length, 'from ETL pipeline');
          }
        }
      } catch (e) {
        console.log('[ETL] metro_stations_flat not available, using seed data');
      }
    }

    loadETLData();
    return () => { cancelled = true; };
  }, []);

  return dataReady;
}

const API_ENDPOINT = "/api/claude";

const C = {
  navy:"#0F1B2D", bg:"#F8FAFB", green:"#1E6B4A", red:"#C84B31",
  blue:"#2563EB", amber:"#F59E0B", lightBlue:"#EFF6FF",
  border:"#E2E8F0", muted:"#64748B", dark:"#1E293B",
};
const scoreColor=(s)=>s>=80?"#1E6B4A":s>=65?"#2563EB":s>=50?"#F59E0B":"#C84B31";
const recoColor=(r="")=>{
  const u=r.toUpperCase();
  if(u.includes("BUY NOW")) return "#1E6B4A";
  if(u.includes("ACCUMULATE")) return "#0891B2";
  if(u.includes("WATCHLIST")) return "#F59E0B";
  if(u.includes("HOLD")) return "#7C3AED";
  if(u.includes("AVOID")) return "#C84B31";
  return C.muted;
};
function parseJSON(t){
  try{
    const c=t.replace(/```json/gi,"").replace(/```/g,"").trim();
    const a=c.indexOf("{"),b=c.indexOf("[");
    const s=(a<0)?b:(b<0)?a:Math.min(a,b);
    if(s<0) return null;
    const sliced=c.slice(s);
    try{ return JSON.parse(sliced); }
    catch(e1){
      // Attempt repair: response was likely truncated mid-JSON.
      // Try trimming to the last complete object/array boundary.
      let repaired=sliced;
      // Remove trailing incomplete content — handles these truncation patterns:
      // 1. Mid-value string:  ,"key": "partial val
      // 2. Mid-key name:      ,"partial_ke
      // 3. Complete key+colon:,"key":
      // 4. Trailing comma:    ,
      repaired=repaired.replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/,"");  // mid-value string
      repaired=repaired.replace(/,\s*"[^"]*"\s*:\s*$/,"");         // key+colon only
      repaired=repaired.replace(/,\s*"[^"]*$/,"");                    // mid-key-name (the Mysuru bug)
      repaired=repaired.replace(/,\s*$/,"");                          // trailing comma
      // Balance braces/brackets
      const opens=(repaired.match(/[\{\[]/g)||[]).length;
      const closes=(repaired.match(/[\}\]]/g)||[]).length;
      let diff=opens-closes;
      // Close in reverse order of likely nesting
      const stack=[];
      for(const ch of repaired){
        if(ch==="{"||ch==="[") stack.push(ch);
        else if(ch==="}"&&stack[stack.length-1]==="{") stack.pop();
        else if(ch==="]"&&stack[stack.length-1]==="[") stack.pop();
      }
      let closer="";
      for(let i=stack.length-1;i>=0;i--) closer+=stack[i]==="{"?"}":"]";
      try{ return JSON.parse(repaired+closer); }
      catch(e2){ return null; }
    }
  }catch(e){}
  return null;
}
// ══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC SCORING ENGINE — real composite math, not AI self-reported
// numbers. The AI still supplies the underlying 0-100 sub-scores (it has the
// contextual knowledge), but the FINAL composite score shown to the user is
// computed here with an auditable formula, so two locations with the same
// inputs always get the same output, and a single AI hallucination on the
// headline number can't slip through uncorrected.
// ══════════════════════════════════════════════════════════════════════════

function normalize(value, min, max, higherIsBetter = true) {
  const clamped = Math.max(min, Math.min(max, value));
  const ratio = (clamped - min) / (max - min);
  return Math.round((higherIsBetter ? ratio : 1 - ratio) * 100);
}

// Geometric mean composite — prevents one very high sub-score from masking a
// critically low one (same principle as the UN Human Development Index).
// A location with Infra=95 but Risk=10 should NOT come out looking like an
// 80/100 overall; a plain weighted average would let that happen.
function compositeGeometric(dims, weights) {
  let product = 1, totalWeight = 0;
  for (const [dim, weight] of Object.entries(weights)) {
    const v = dims[dim];
    if (v != null && v > 0 && weight > 0) {
      product *= Math.pow(v, weight);
      totalWeight += weight;
    }
  }
  if (totalWeight === 0) return 0;
  return Math.round(Math.pow(product, 1 / totalWeight));
}

// Weights mirror the SINFO panel already shown in the UI, renormalized to
// exclude Risk/Catalyst (those modulate the score separately, see below).
const GROWTH_SCORE_WEIGHTS = {
  infrastructure_score: 0.25,
  population_score: 0.20,
  economic_score: 0.20,
  connectivity_score: 0.15,
  urban_expansion_score: 0.10,
  market_momentum_score: 0.05,
  scarcity_score: 0.05,
};

// Computes the real composite growth score from sub-scores, then applies a
// risk-adjustment penalty (high risk pulls the score down further than a
// pure geometric mean already would, since risk is asymmetric — a single
// serious legal/flood risk can sink an otherwise-strong locality).
function computeGrowthScore(d) {
  const base = compositeGeometric(d, GROWTH_SCORE_WEIGHTS);
  const risk = d.risk_score != null ? d.risk_score : 50;
  const catalyst = d.catalyst_score != null ? d.catalyst_score : 50;
  // Risk above 50 (i.e. riskier) pulls score down up to 15pts at risk=100.
  const riskPenalty = Math.max(0, (risk - 50) / 50) * 15;
  // Catalyst above 50 gives a modest boost up to 8pts at catalyst=100.
  const catalystBoost = Math.max(0, (catalyst - 50) / 50) * 8;
  const final = Math.round(base - riskPenalty + catalystBoost);
  return Math.max(0, Math.min(100, final));
}

// ── Market Heat Index — spread between asking/estimated price and a
// reference "fair value" baseline (city-tier rate). Tells you whether a
// locality's current pricing already reflects its growth story, or is
// still underpriced relative to fundamentals.
function marketHeatIndex(actual_price, reference_value) {
  if (!actual_price || !reference_value) return null;
  const ratio = actual_price / reference_value;
  if (ratio > 2.0) return { level: "Overheated", score: 95, signal: "Caution", ratio };
  if (ratio > 1.5) return { level: "Hot", score: 75, signal: "Hold/Watch", ratio };
  if (ratio > 1.0) return { level: "Fair Value", score: 55, signal: "Neutral", ratio };
  if (ratio > 0.8) return { level: "Underpriced", score: 35, signal: "Opportunity", ratio };
  return { level: "Deep Discount", score: 15, signal: "Investigate Why", ratio };
}

// ── Flood Risk Score — elevation/drainage/history based composite.
// elevation_zone: 1 (high ground) to 5 (lake-bed/low-lying)
function floodScore(elevation_zone, drain_coverage_pct, incidents_per_yr, lake_distance_km) {
  const elev = normalize(elevation_zone, 1, 5, false);
  const drain = normalize(drain_coverage_pct, 0, 100, true);
  const hist = normalize(incidents_per_yr, 0, 15, false);
  const lake = normalize(lake_distance_km, 0, 2, true);
  return Math.round(elev * 0.35 + drain * 0.25 + hist * 0.25 + lake * 0.15);
}

// ── Infrastructure Appreciation Potential — scores the PIPELINE specifically
// (as distinct from infrastructure_score which the AI estimates more
// broadly). This one is built from the KARNATAKA_INFRA dataset below, with
// a delay-discount applied since Indian infra timelines slip routinely.
function infrastructureAppreciationScore(locality) {
  let score = 0;
  if (locality.metro_operational) score += 25;
  if (locality.metro_under_construction) score += 40; // best appreciation window — priced in less than operational
  if (locality.metro_proposed) score += 20;
  if (locality.nh_within_5km) score += 15;
  if (locality.industrial_corridor_node) score += 35;
  if (locality.smart_city) score += 10;
  // Delay discount: Bengaluru metro phases have historically slipped 2-7 years.
  // A project "under construction" for 5+ years gets a partial discount since
  // the appreciation window itself starts shrinking the longer it drags.
  if (locality.years_in_construction > 4) score *= 0.85;
  return Math.min(100, Math.round(score));
}

// ── Time decay weighting — for any future crowdsourced/user-submitted data
// point. Recent data is trusted more than old data, with a configurable
// half-life (default 90 days).
function decayWeight(submittedAt, halfLifeDays = 90) {
  const daysSince = (Date.now() - new Date(submittedAt).getTime()) / 86400000;
  return Math.exp(-0.693 * daysSince / halfLifeDays);
}

// ── Outlier detection — flags a new data point (e.g. a user-submitted price)
// as statistically suspicious if it's more than 2 standard deviations from
// the existing sample. Needs at least 5 prior points to be meaningful.
function isOutlier(newValue, existingValues) {
  if (!existingValues || existingValues.length < 5) return false;
  const mean = existingValues.reduce((a, b) => a + b, 0) / existingValues.length;
  const variance = existingValues.reduce((s, v) => s + (v - mean) ** 2, 0) / existingValues.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return false;
  return Math.abs((newValue - mean) / stdDev) > 2;
}


// ══════════════════════════════════════════════════════════════════════════
// KARNATAKA INFRASTRUCTURE PIPELINE — curated from verified public sources.
// This is NOT a live feed (no government API exists for this); it's a
// point-in-time snapshot researched and cited as of mid-2026. Update this
// table periodically as projects progress — it will go stale otherwise.
// Sources cited per entry. Indian infra timelines slip routinely (BMRCL
// Phase 2 alone slipped 7+ years from original plan) — treat "expected"
// dates as directional, not guaranteed.
// ══════════════════════════════════════════════════════════════════════════

const KARNATAKA_INFRA = {
  metro: {
    source: "BMRCL public announcements, Wikipedia (Namma Metro), themetrorailguy.com, Deccan Herald (cited mid-2025 to mid-2026)",
    asOf: "2026-06",
    lines: [
      {name:"Purple Line", status:"operational", note:"Whitefield (Kadugodi)–Challaghatta corridor, via Majestic, MG Road, Indiranagar",
        corridor:["whitefield","kadugodi","majestic","mg road","indiranagar","baiyappanahalli","kengeri","challaghatta"]},
      {name:"Green Line", status:"operational", note:"Madavara–Silk Institute corridor via Majestic and Kanakapura Road (Yelachenahalli, Konanakunte, Talaghattapura, Silk Institute) — the line directly serving South Bengaluru's Kanakapura Road belt",
        corridor:["kanakapura","yelachenahalli","konanakunte","talaghattapura","banashankari","jayanagar","basavanagudi","silk institute","nagasandra","peenya","yeshwanthpur","madavara","tumkur road","kaggalipura","harohalli","anjanapura","uttarahalli","subramanyapura","vajarahalli"]},
      {name:"Yellow Line", status:"operational", note:"RV Road–Bommasandra, fully operational since Aug 2025 inauguration (no longer phased)",
        corridor:["btm layout","silk board","electronic city","bommasandra","jayanagar","ragigudda","hosur road","bommanahalli"]},
      {name:"Pink Line", status:"under construction", length_km:21.25, stations:18,
        note:"Kalena Agrahara–Nagawara, phased opening targeted 2026, has slipped before",
        corridor:["kalena agrahara","gottigere","jayadeva","nagawara","cantonment","jp nagar 4th phase"]},
      {name:"Blue Line Phase 2A", status:"under construction", length_km:19.75,
        note:"Silk Board–KR Puram, repeatedly delayed, latest target mid-2026",
        corridor:["silk board","krishnarajapura","kr puram","marathahalli","ecospace"]},
      {name:"Blue Line Phase 2B", status:"under construction", length_km:38.44,
        note:"KR Puram–Airport via Hebbal and Yelahanka, pushed to end-2026",
        corridor:["kr puram","hebbal","yelahanka","airport","kempegowda international","devanahalli","silk board","electronic","bommasandra"]},
      {name:"Orange Line Corridor 1", status:"pre-construction (land acquisition stage)", length_km:32.15, stations:22,
        note:"JP Nagar 4th Phase–Kempapura via western ORR (Banashankari, Mysuru Road, Nagarbhavi, Peenya, Hebbal), Cabinet approved Aug 2024, target ~2029 (officials express doubt on this date) — relevant to JP Nagar/Kanakapura Road area, not yet to outer Kanakapura Road stretches like Kaggalipura",
        corridor:["jp nagar","mysuru road","nagarbhavi","sumanahalli","peenya","hebbal","kempapura","banashankari","kanakapura"]},
      {name:"Orange Line Corridor 2", status:"pre-construction (land acquisition stage)", length_km:12.5, stations:9,
        note:"Hosahalli–Kadabagere via Magadi Road, same approval/timeline as Corridor 1",
        corridor:["hosahalli","kadabagere","magadi road","byadarahalli","herohalli"]},
    ],
    networkAtPhase3Completion_km: 220.20,
    plannedNotOperational:["Phase 4 (Hoskote, Bidadi, Harohalli, Tumkur extensions) is still at the proposal stage with no approved timeline — do not treat as committed."],
  },
  masterPlan: {
    source: "BDA Revised Master Plan (RMP) 2031, official volumes",
    asOf: "2026-06",
    zones: [
      {zone:"A", area:"Within Outer Ring Road", designation:"Stabilisation zone — discourages further densification/commercialization"},
      {zone:"B", area:"Outside ORR up to Conurbation Limit", designation:"Consolidation zone — upgraded infrastructure priority"},
      {zone:"C", area:"Beyond conurbation limit to LPA boundary", designation:"Preservation zone — agriculture-oriented, productive landscape focus"},
    ],
    note:"FSI/FAR in Bengaluru is road-width based, not purely zone based — a plot facing a wider road has materially higher buildable area regardless of zone.",
  },
};

// Given a locality's known proximity to named metro lines/corridors, derive
// the boolean flags the infrastructureAppreciationScore() function expects.
// This is a simple keyword-based lookup against the curated dataset above —
// NOT a live geocoded distance calculation (would need real coordinates for
// each metro alignment, which isn't available as open data either).
function getKarnatakaInfraContext(localityName) {
  // Match ONLY on the locality name itself — using notes/thesis caused
  // every Electronic City analysis to match ALL metro lines (since the
  // AI mentions "Green Line", "Blue Line" etc in growth drivers).
  const text = (localityName||"").toLowerCase();
  const GENERIC_WORDS = new Set(["line","phase","corridor","metro","road","nagar","layout","city","park","garden","lake","colony"]);
  const relevantLines = KARNATAKA_INFRA.metro.lines.filter(l=>{
    const nameWords = l.name.toLowerCase().split(" ").filter(w=>w.length>3 && !GENERIC_WORDS.has(w));
    const keywords = [...(l.corridor||[]), ...nameWords];
    return keywords.some(kw=>kw.length>4 && text.includes(kw));
  });
  return { relevantLines, source: KARNATAKA_INFRA.metro.source, asOf: KARNATAKA_INFRA.metro.asOf };
}


const STATE_GROWTH={"Karnataka":82,"Gujarat":85,"Tamil Nadu":78,"Maharashtra":76,"Andhra Pradesh":72,"Telangana":74,"Rajasthan":65,"Haryana":70,"Uttar Pradesh":62,"West Bengal":60,"Kerala":68,"Punjab":63,"Madhya Pradesh":58,"Bihar":52,"Chhattisgarh":55,"Jharkhand":53,"Orissa":57,"Uttaranchal":60,"Himachal Pradesh":58,"Assam":54,"Delhi":71,"Goa":66,"Jammu and Kashmir":50,"Arunachal Pradesh":48,"Manipur":47,"Meghalaya":48,"Mizoram":46,"Nagaland":45,"Sikkim":50,"Tripura":49,"Chandigarh":72,"Puducherry":65,"Andaman and Nicobar":44,"Lakshadweep":42,"Dadra and Nagar Haveli":60,"Daman and Diu":58};
const ZC={mega:"#15803D",hot:"#1D4ED8",growth:"#D97706",stable:"#94A3B8",low:"#FCA5A5"};
const stateColor=(name)=>{const sc=STATE_GROWTH[name]||50;return sc>=90?ZC.mega:sc>=80?ZC.hot:sc>=65?ZC.growth:sc>=50?ZC.stable:ZC.low;};

const _GP = [
  `{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"n":"Andaman and Nicobar"},"geometry":{"type":"MultiPolygon","coordinates":[[[[93.78772735595709,6.85264015197771],[93.78849029541021,6.8525710105896],[93.789047241211,6.8525710105896],[93.789047241211,6.852291107177678]]],[[[93.71958160400408,7.207500934600944],[93.71958160400408,7.206870079040584],[93.71930694580107,7.206459999084473],[93.71881866455095,7.20639085769659]]],[[[93.85,7.24],[93.95,7.0],[93.83,6.75],[93.66,7.13],[93.85,7.24]]],[[[93.84874725341803,7.289868831634749],[93.84867858886736,7.289456844329834],[93.84784698486357,7.288832187652531],[93.8469467163086,7.288138866424561]]],[[[93.66369628906267,7.384031772613696],[93.66373443603521,7.383797168731746],[93.66410827636724,7.383800983429126],[93.66423034667986,7.383767127990836]]],[[[93.76860809326172,7.402218818664721],[93.77111053466803,7.39972114563011],[93.7716674804688,7.39972114563011],[93.77194213867216,7.39944505691534]]],[[[93.68944549560564,7.409721851349104],[93.68972015380888,7.409443855285588],[93.69000244140642,7.409443855285588],[93.69027709960943,7.409165859222469]]],[[[93.71,7.44],[93.76,7.36],[93.65,7.24],[93.63,7.37],[93.71,7.44]]],[[[93.6477813720706,7.476668834686336],[93.64805603027361,7.476390838623217],[93.6488876342774,7.476390838623217],[93.64916992187517,7.476110935211295]]],[[[93.63445281982416,7.477781772613582],[93.63471984863287,7.477500915527571],[93.63445281982416,7.477221012115479],[93.63444519042997,7.47666692733776]]],[[[93.54360198974615,7.525001049041691],[93.54582977294922,7.522780895233382],[93.54582977294922,7.52250099182146],[93.54693603515642,7.521390914917106]]],[[[93.34156036376959,7.906459808349723],[93.34159851074224,7.905920028686637],[93.34215545654303,7.905944824219034],[93.34214019775396,7.905624866485653]]],[[[93.3396301269533,7.91114997863798],[93.33965301513678,7.910870075225887],[93.34018707275408,7.910871982574463],[93.34019470214861,7.909731864929199]]],[[[93.38,8.02],[93.4`,
  `6,7.87],[93.32,7.93],[93.38,8.02]]],[[[93.55,8.03],[93.58,7.93],[93.51,7.98],[93.55,8.03]]],[[[93.57861328125017,8.12527942657465],[93.5794067382813,8.124839782714844],[93.579818725586,8.124913215637378],[93.58030700683611,8.124982833862305]]],[[[93.53,8.23],[93.5,8.0],[93.45,8.17],[93.53,8.23]]],[[[93.23528289794939,8.265560150146541],[93.23583221435547,8.265000343322924],[93.2363891601562,8.265000343322924],[93.2375030517581,8.263890266418741]]],[[[93.13,8.36],[93.2,8.19],[93.09,8.27],[93.13,8.36]]],[[[93.65249633789068,8.394445419311694],[93.65305328369146,8.39388942718523],[93.65305328369146,8.393610954284838],[93.653335571289,8.393333435058537]]],[[[93.63491821289068,8.394643783569336],[93.63464355468744,8.394643783569336],[93.63394927978516,8.394922256469897],[93.63387298584013,8.39561462402338]]],[[[93.04389190673857,8.473333358764933],[93.04389190673857,8.473054885864542],[93.04418182373064,8.47305965423584],[93.04556274414068,8.47166919708269]]],[[[93.6118774414063,8.484541893005371],[93.61147308349615,8.484471321105957],[93.61083221435564,8.48499965667753],[93.61083221435564,8.485278129577921]]],[[[93.6159973144533,8.573625564575138],[93.61711120605469,8.57244968414301],[93.61794281005865,8.57113075256342],[93.61801147460966,8.569466590881348]]],[[[93.60944366455107,8.581666946411133],[93.60944366455107,8.58138942718523],[93.60916900634771,8.581110954284668],[93.60916900634771,8.579998970031909]]],[[[92.85916900634783,8.82013130188011],[92.85888671875028,8.819930076599405],[92.8583297729495,8.819723129272575],[92.85736083984403,8.819234848022461]]],[[[92.79332733154297,9.118890762329215],[92.79332733154297,9.118611335754338],[92.79444122314482,9.118611335754338],[92.79444122314482,9.118332862853947]]],[[[92.80416870117216,9.120833396911621],[92.80416870117216,9.120277404785156],[92.804443359375,9.12027931213396],[92.804443359375,9.120000839233569]]],[[[92.81416320800798,9.126943588257063],[92.81416320800798,9.126387596130428],[92.81445312500028,9.126390457`,
  `15349],[92.81445312500028,9.12611198425293]]],[[[92.79,9.24],[92.83,9.14],[92.73,9.12],[92.79,9.24]]],[[[92.52,10.9],[92.59,10.79],[92.57,10.58],[92.51,10.51],[92.39,10.53],[92.38,10.78],[92.52,10.9]]],[[[92.60888671875,10.938610076904467],[92.60916900634771,10.938335418701229],[92.61000061035185,10.938335418701229],[92.61027526855469,10.938056945801065]]],[[[92.22673797607428,10.98229026794445],[92.22736358642607,10.982221603393782],[92.22777557373075,10.982221603393782],[92.22805786132818,10.982221603393782]]],[[[92.66335296630865,10.98180007934593],[92.66194152832048,10.981391906738395],[92.66166687011747,10.981670379638786],[92.66139221191406,10.981670379638786]]],[[[92.72566223144548,11.144218444824276],[92.7257614135745,11.144159317016545],[92.72589874267584,11.143815040588379],[92.72589874267584,11.14346790313715]]],[[[92.7319412231447,11.14973068237299],[92.73249816894548,11.149170875549544],[92.73278045654303,11.149170875549544],[92.73332977294928,11.148612022400187]]],[[[92.67694091796903,11.183610916137809],[92.67749786376982,11.18305683135992],[92.67804718017584,11.1830606460573],[92.67833709716814,11.182781219482422]]],[[[92.70597839355486,11.289166450500602],[92.70639038085955,11.288330078125],[92.70659637451172,11.2876367568972],[92.70694732666033,11.287359237670898]]],[[[92.7005462646485,11.31138992309593],[92.70166778564459,11.310279846191406],[92.70166778564459,11.310000419616927],[92.70291900634766,11.308679580688533]]],[[[92.72305297851568,11.316388130188045],[92.72277832031267,11.316109657287654],[92.72277832031267,11.31583213806158],[92.7213897705081,11.314443588256836]]],[[[92.54833221435553,11.393029212951603],[92.54801940917997,11.392868995666674],[92.5474929809572,11.3931179046632],[92.54696655273443,11.393567085266113]]],[[[92.55757904052734,11.390936851501465],[92.55724334716814,11.390220642089844],[92.55683135986345,11.390230178833008],[92.55564117431669,11.390940666199015]]],[[[92.67346191406256,11.487520217895508],[92.67317199707048,11`,
  `.4873561859132],[92.67259216308594,11.487330436706713],[92.6719360351563,11.487360000610579]]],[[[92.61048889160162,11.504050254821777],[92.61021423339838,11.503927230835245],[92.60980987548857,11.504079818725813],[92.60941314697294,11.504239082336653]]],[[[92.64444732666021,11.513030052185059],[92.64405059814459,11.513030052185059],[92.64382171630876,11.513167381286792],[92.64368438720709,11.513305664062557]]],[[[92.64,11.51],[92.69,11.37],[92.6,11.35],[92.64,11.51]]],[[[92.27179718017607,11.515991210937784],[92.2706832885745,11.515988349914721],[92.2705383300783,11.516190528869686],[92.27040100097662,11.516469001770076]]],[[[92.60465240478544,11.53458213806158],[92.60465240478544,11.534305572509766],[92.60520935058622,11.534305572509766],[92.60520935058622,11.53458213806158]]],[[[92.56035614013678,11.537990570068416],[92.56051635742193,11.537581443786792],[92.56054687500006,11.537111282348633],[92.56054687500006,11.536609649658203]]],[[[92.62797546386736,11.542161941528605],[92.62741851806658,11.542161941528605],[92.62706756591803,11.542711257934627],[92.62679290771513,11.543267250061092]]],[[[92.61000061035185,11.5588893890382],[92.61020660400385,11.558749198913802],[92.61076354980497,11.559371948242188],[92.61166381835943,11.56069374084484]]],[[[92.574516296387,11.562571525573787],[92.57367706298834,11.562571525573787],[92.57367706298834,11.562847137451286],[92.5734024047851,11.56312465667719]]],[[[92.5675125122072,11.570817947387638],[92.56772613525408,11.570539474487248],[92.56765747070341,11.570126533508244],[92.5675125122072,11.569990158081225]]],[[[92.59718322753918,11.541669845581112],[92.59697723388678,11.541279792785929],[92.59694671630865,11.540850639343546],[92.59694671630865,11.540420532226676]]],[[[92.57826232910162,11.581805229187239],[92.57805633544928,11.58166599273676],[92.57771301269537,11.58319091796892],[92.57659912109403,11.584858894348145]]],[[[92.61102294921892,11.58825969696045],[92.61139678955095,11.588020324707259],[92.61170959472685,11.`,
  `587621688843],[92.61178588867205,11.587169647217024]]],[[[92.2189331054688,11.5923233032226],[92.21906280517595,11.592303276062069],[92.21934509277372,11.592492103576944],[92.21988677978521,11.592461585998763]]],[[[92.5397567749024,11.603320121765137],[92.54003906250017,11.603256225585938],[92.54091644287121,11.603313446045092],[92.54132843017607,11.603129386901855]]],[[[92.6995697021485,11.664450645446777],[92.699935913086,11.664237022400073],[92.70030975341803,11.664019584655819],[92.70070648193365,11.663845062256087]]],[[[92.76225280761736,11.669699668884562],[92.7617797851563,11.669551849365234],[92.76104736328153,11.669838905334473],[92.76112365722673,11.670538902282715]]],[[[92.72498321533232,11.689121246337834],[92.72546386718767,11.6887722015382],[92.72586059570312,11.688811302185002],[92.7261505126956,11.688480377197322]]],[[[92.55091857910173,11.721240043640194],[92.5506973266601,11.721240043640194],[92.55036163330095,11.721439361572493],[92.5500106811524,11.72185134887718]]],[[[93.08297729492193,11.779680252075138],[93.08244323730497,11.779290199279956],[93.08181762695318,11.779080390930233],[93.08145904541027,11.779159545898665]]],[[[93.02083587646513,11.843331336975211],[93.02111053466814,11.843055725097884],[93.02166748046892,11.843059539794865],[93.02249908447271,11.842219352722452]]],[[[92.59694671630865,11.905289649963436],[92.59638977050787,11.905289649963436],[92.59638977050787,11.905561447143612],[92.59583282470709,11.906112670898608]]],[[[92.565658569336,11.949771881103743],[92.56610107421903,11.949560165405273],[92.56659698486328,11.949601173400822],[92.5671463012697,11.950021743774585]]],[[[92.73243713378935,11.95422267913824],[92.73219299316412,11.953901290893668],[92.73188018798857,11.953550338745288],[92.73152160644526,11.95319938659668]]],[[[92.74308013916021,11.964510917663688],[92.74277496337885,11.964448928833292],[92.74233245849621,11.964547157287598],[92.74169158935547,11.964953422546387]]],[[[92.75013732910162,11.968339920044116],[92`,
  `.75048828125006,11.967990875244084],[92.75070190429693,11.967990875244084],[92.7519607543947,11.967849731445426]]],[[[92.59610748291016,11.976108551025447],[92.597221374512,11.97499942779541],[92.597221374512,11.974440574646053],[92.59693908691412,11.974167823791618]]],[[[92.58275604248047,11.975981712341536],[92.58238220214861,11.97572040557884],[92.58211517333996,11.975942611694393],[92.58175659179716,11.976301193237305]]],[[[92.77604675292974,12.017709732055607],[92.77648925781278,12.017149925232161],[92.77684783935553,12.016679763794173],[92.77688598632841,12.01621055603033]]],[[[92.97,12.03],[93.04,11.88],[92.93,12.0],[92.97,12.03]]],[[[92.96982574462896,12.06400680542015],[92.969741821289,12.063944816589355],[92.96951293945341,12.06414985656761],[92.969535827637,12.06435680389427]]],[[[92.99136352539062,12.108927726745776],[92.99154663085955,12.108071327209586],[92.9921493530274,12.107234954834155],[92.99256896972662,12.106961250305403]]],[[[92.993881225586,12.109939575195597],[92.99305725097673,12.109939575195597],[92.9924621582033,12.110530853271484],[92.99249267578142,12.111639976501579]]],[[[92.74285125732428,12.114999771118107],[92.74286651611334,12.114720344543457],[92.74315643310541,12.114720344543457],[92.74315643310541,12.113899230957259]]],[[[92.94863128662126,12.115840911865234],[92.9489059448245,12.115262031555119],[92.94912719726591,12.115262031555119],[92.94919586181658,12.114441871643066]]],[[[92.62884521484386,12.11245632171648],[92.62821197509771,12.112200736999512],[92.62800598144548,12.1124401092531],[92.62802124023443,12.112750053405932]]],[[[92.63062286376947,12.11791038513195],[92.63050842285162,12.11791038513195],[92.63019561767607,12.117997169494743],[92.63013458251959,12.118223190307845]]],[[[93.09793090820312,12.137191772460994],[93.09799957275396,12.136953353881893],[93.09821319580084,12.136953353881893],[93.09821319580084,12.13664340972906]]],[[[93.12052917480474,12.148349761962947],[93.12052917480474,12.14800167083763],[93.12021636`,
  `962919,12.148003578186035],[93.12021636962919,12.147762298584212]]],[[[92.84584808349615,12.147562026977823],[92.84552764892607,12.147521018982047],[92.84501647949219,12.147568702697868],[92.84443664550776,12.147850990295638]]],[[[93.03,12.16],[93.05,12.05],[92.96,12.14],[93.03,12.16]]],[[[92.75895690917997,12.181310653686523],[92.75927734375006,12.180801391601562],[92.76059722900396,12.180821418762491],[92.76071929931658,12.18060302734375]]],[[[92.72029113769548,12.180438041686955],[92.72000122070318,12.180270195007495],[92.71987152099638,12.180169105529899],[92.71982574462902,12.18011283874523]]],[[[92.73137664794939,12.187581062316895],[92.73119354248064,12.18743991851801],[92.73123931884771,12.186621665954704],[92.73094940185541,12.186621665954704]]],[[[93.06860351562517,12.211334228515625],[93.07021331787138,12.211263656616211],[93.07025146484403,12.210988044738883],[93.07055664062506,12.210819244384766]]],[[[92.68302917480497,12.214900970459212],[92.682876586914,12.214720726013184],[92.68219757080084,12.21484184265131],[92.6817932128908,12.215051651001033]]],[[[93.01988983154325,12.22515964508085],[93.02030944824236,12.224949836731128],[93.02094268798834,12.225023269653434],[93.02101135253935,12.22474670410162]]],[[[92.93898010253918,12.223860740661621],[92.93916320800787,12.223328590393237],[92.93968963623053,12.222780227661303],[92.93998718261713,12.222380638122786]]],[[[92.7,12.24],[92.78,12.05],[92.68,11.82],[92.79,11.9],[92.76,11.7],[92.67,11.65],[92.76,11.67],[92.71,11.48],[92.51,11.85],[92.56,11.95],[92.61,11.87],[92.7,12.24]]],[[[92.73061370849626,12.242453575134334],[92.73092651367216,12.24189281463623],[92.73147583007841,12.24189281463623],[92.73147583007841,12.241640090942326]]],[[[92.88054656982422,12.25000000000017],[92.88083648681669,12.249719619750977],[92.8811111450197,12.24972152709978],[92.8819427490235,12.248889923095987]]],[[[92.86646270751959,12.235621452331543],[92.86621093750017,12.23551082611084],[92.86565399169939,12.235812187194824],[`,
  `92.86508941650408,12.236350059509334]]],[[[92.69890594482416,12.24483776092535],[92.69860076904303,12.244730949402026],[92.69824981689459,12.244814872741927],[92.69777679443376,12.245011329650993]]],[[[92.90167236328142,12.255849838256779],[92.9019393920899,12.255521774291992],[92.90215301513678,12.255150794982853],[92.90225982666033,12.254711151123047]]],[[[93.07777404785162,12.261944770813159],[93.0780563354495,12.261667251586857],[93.07833099365251,12.261671066284407],[93.07861328125028,12.26139068603527]]],[[[92.90143585205107,12.262151718139592],[92.90141296386747,12.259071350097713],[92.90082550048834,12.258556365967024],[92.90029907226591,12.258614540100268]]],[[[92.73760986328153,12.271332740783805],[92.73729705810564,12.270730972290266],[92.73703765869169,12.270735740661735],[92.73703765869169,12.270457267761174]]],[[[93.02966308593767,12.280171394348201],[93.02997589111357,12.279815673828352],[93.03029632568365,12.279650688171387],[93.03044128417986,12.279289245605526]]],[[[92.75008392333984,12.287694931030217],[92.75006103515642,12.286875724792424],[92.74983978271484,12.286881446838379],[92.74981689453153,12.286040306091309]]],[[[92.737060546875,12.285181045532227],[92.73680114746105,12.284899711608944],[92.73676300048834,12.281850814819336],[92.73622894287121,12.281846046447868]]],[[[92.76673889160162,12.270320892334155],[92.766616821289,12.269881248474348],[92.76639556884794,12.269504547119254],[92.7661895751956,12.269136428833008]]],[[[92.75444793701189,12.294722557067928],[92.7547225952149,12.294443130493278],[92.75499725341814,12.294443130493278],[92.75499725341814,12.293610572814998]]],[[[92.77118682861322,12.294923782348633],[92.77120971679705,12.29350566864025],[92.77149200439459,12.293549537658691],[92.77143859863298,12.292959213257063]]],[[[92.8780593872072,12.293649673461971],[92.8777465820313,12.29364109039335],[92.87732696533209,12.293829917907658],[92.87696075439459,12.294239997863997]]],[[[92.71141815185553,12.296070098877124],[92.712051391`,
  `60185,12.295981407165527],[92.71272277832037,12.29603195190441],[92.71333312988287,12.295851707458553]]],[[[92.76590728759783,12.299070358276424],[92.7659301757813,12.298520088195914],[92.76562500000028,12.298541069030762],[92.7656631469726,12.298003196716422]]],[[[92.94139862060553,12.280801773071289],[92.94165802001982,12.280330657959041],[92.94193267822283,12.279891014099235],[92.9421463012697,12.279471397400187]]],[[[92.78,12.31],[92.89,12.27],[92.76,12.06],[92.78,12.31]]],[[[93.07256317138672,12.31904411315918],[93.07259368896501,12.318319320678938],[93.07287597656261,12.31815147399908],[93.07318878173828,12.317909240722827]]],[[[93.8396987915039,12.320819854736442],[93.85774993896496,12.293129920959643],[93.86033630371111,12.294710159301758],[93.86160278320341,12.295536994934082]]],[[[92.91278076171875,12.331665992736987],[92.91222381591803,12.331665992736987],[92.91166687011724,12.332221984863281],[92.9116821289063,12.332490921020508]]],[[[92.90593719482428,12.338507652282715],[92.90573883056646,12.338351249694938],[92.90546417236322,12.33845329284685],[92.90507507324247,12.338761329650879]]],[[[92.91173553466825,12.33795166015625],[92.91104888916033,12.337694168090877],[92.91072082519537,12.337731361389274],[92.91040039062528,12.337881088257006]]],[[[92.89693450927751,12.392077445983944],[92.89671325683611,12.391969680786133],[92.89639282226568,12.392040252685547],[92.89591979980497,12.392330169677848]]],[[[92.85290527343756,12.408830642700423],[92.85330200195318,12.408753395080566],[92.85405731201178,12.408881187438965],[92.85463714599615,12.408789634704874]]],[[[92.89916992187494,12.407500267028752],[92.89861297607422,12.407500267028752],[92.89861297607422,12.407771110534782],[92.89749908447283,12.408889770507983]]],[[[92.88935089111334,12.412851333618221],[92.88913726806646,12.412570953369254],[92.8889999389649,12.412710189819563],[92.88878631591803,12.412987709045467]]],[[[92.86587524414068,12.421003341674918],[92.86589813232428,12.420686721802042],[92.8`,
  `6751556396479,12.420722961425781],[92.86754608154314,12.420450210571346]]],[[[92.90323638916033,12.42018985748291],[92.90288543701178,12.420080184936467],[92.90248107910156,12.420240402221793],[92.90200042724638,12.420372009277344]]],[[[92.83173370361334,12.426821708679483],[92.83277893066435,12.426667213439941],[92.83361053466814,12.42667198181158],[92.83389282226591,12.426390647888127]]],[[[92.95536041259771,12.414690017700195],[92.95501708984403,12.414191246032658],[92.95472717285173,12.413699150085392],[92.95443725585966,12.413241386413802]]],[[[92.87503051757818,12.44508266448969],[92.87538146972673,12.44481086730957],[92.8756561279298,12.44481086730957],[92.87586975097685,12.444741249084416]]],[[[92.67945861816406,12.541128158569393],[92.67988586425798,12.541111946106241],[92.68032073974615,12.541111946106241],[92.68073272705107,12.541111946106241]]],[[[92.70242309570318,12.637869834900187],[92.70204162597662,12.637830734252987],[92.70160675048845,12.638091087341422],[92.70121765136736,12.638530731201229]]],[[[92.73144531250006,12.703124046325797],[92.73145294189459,12.702590942382756],[92.73087310791021,12.702590942382756],[92.73088073730474,12.702930450439453]]],[[[92.72425842285185,12.736729621887207],[92.72425079345732,12.7358913421632],[92.72621917724626,12.735909461975325],[92.72615814209013,12.736211776733455]]],[[[92.72669982910185,12.751379966735954],[92.72653198242216,12.751379966735954],[92.72623443603533,12.751466751098576],[92.72598266601557,12.751689910888786]]],[[[92.65584564209001,12.76895904541027],[92.6556472778322,12.768881797790584],[92.65537261962919,12.768936157226676],[92.65503692626947,12.769309997558878]]],[[[92.71707916259783,12.774780273437727],[92.71624755859403,12.774780273437727],[92.71623229980497,12.775311470031795],[92.71562957763683,12.775650978088493]]],[[[92.72499847412138,12.761666297912825],[92.7244415283206,12.761666297912825],[92.7244415283206,12.761941909790153],[92.72277832031267,12.76361179351835]]],[[[92.716186523437`,
  `56,12.79729270935087],[92.71620941162138,12.796734809875602],[92.71651458740234,12.796734809875602],[92.71651458740234,12.795895576477278]]],[[[92.71676635742193,12.800591468811092],[92.71676635742193,12.800071716308537],[92.71704101562517,12.800071716308537],[92.71704101562517,12.798692703247298]]],[[[92.71760559082031,12.803103446960677],[92.71704101562517,12.80255985260004],[92.71596527099615,12.802584648132438],[92.71590423584001,12.803123474121037]]],[[[92.7109680175783,12.82903003692627],[92.71121978759771,12.82892990112316],[92.71152496337908,12.82901859283453],[92.71192932128923,12.829182624816838]]],[[[92.72763061523443,12.836471557617301],[92.72763061523443,12.835887908935547],[92.72786712646513,12.835910797119368],[92.72788238525419,12.835330009460677]]],[[[92.73178100585943,12.856430053711165],[92.73178100585943,12.855869293213061],[92.73147583007841,12.855880737304744],[92.73147583007841,12.85531997680664]]],[[[92.72861480712919,12.864445686340446],[92.72861480712919,12.862776756286735],[92.7288894653322,12.862776756286735],[92.7288894653322,12.863333702087516]]],[[[92.77856445312506,12.864757537841854],[92.77842712402372,12.864660263061637],[92.77809906005876,12.864654541015682],[92.7779388427735,12.864673614501953]]],[[[92.76547241210932,12.854721069336165],[92.76506042480497,12.854640960693416],[92.7645263671875,12.85480976104759],[92.76403045654303,12.855051040649357]]],[[[92.75959777832048,12.877590179443303],[92.76010131835966,12.877569198608455],[92.76004028320318,12.877811431884936],[92.76032257080072,12.877790451050089]]],[[[92.7855529785158,12.893334388733024],[92.78583526611357,12.893055915832633],[92.78639221191418,12.893059730530013],[92.78666687011736,12.892780303955135]]],[[[92.89370727539062,12.898564338684196],[92.89380645751982,12.898501396179483],[92.89393615722662,12.898503303527889],[92.89391326904303,12.898254394531364]]],[[[92.75508117675787,12.912811279297046],[92.75505828857428,12.912253379821777],[92.75538635253923,12.912253379`,
  `821777],[92.7554016113283,12.911414146423454]]],[[[92.86476135253912,12.912481307983455],[92.86421203613293,12.912481307983455],[92.86421203613293,12.912760734558162],[92.86307525634794,12.913647651672477]]],[[[92.79498291015653,12.911258697509822],[92.79524993896501,12.910840034484863],[92.79556274414091,12.910443305969409],[92.79592132568365,12.910037994384936]]],[[[92.91307830810575,12.917289733886776],[92.91200256347673,12.916410446166992],[92.91200256347673,12.914180755615348],[92.91230010986357,12.914180755615348]]],[[[92.76815032958984,12.917540550231877],[92.76815032958984,12.91641902923584],[92.76756286621088,12.916420936584586],[92.76753997802763,12.91674995422386]]],[[[92.93531799316412,12.918089866638297],[92.93534088134771,12.917799949646223],[92.93585205078142,12.917799949646223],[92.93638610839861,12.917289733886776]]],[[[92.76702117919939,12.924701690673771],[92.76698303222685,12.923919677734375],[92.7672958374024,12.923919677734375],[92.76735687255888,12.923399925232218]]],[[[92.9,12.92],[92.97,12.5],[92.91,12.41],[92.79,12.47],[92.9,12.32],[92.72,12.3],[92.68,12.61],[92.79,12.67],[92.73,12.67],[92.72,12.83],[92.9,12.92]]],[[[92.77420043945341,12.931133270263729],[92.77456665039074,12.930573463440112],[92.77560424804705,12.930573463440112],[92.77564239501953,12.92863845825201]]],[[[92.87702178955107,12.932061195373649],[92.87722778320341,12.931671142578068],[92.8774719238283,12.931353569030705],[92.87773132324224,12.931041717529297]]],[[[92.76561737060575,12.932523727417276],[92.7656631469726,12.931425094604435],[92.76590728759783,12.931429862976074],[92.7659530639649,12.92975044250494]]],[[[92.89277648925787,12.937220573425577],[92.89282989501982,12.936421394348145],[92.89170074462919,12.93642330169672],[92.89141082763689,12.93560981750511]]],[[[92.90142822265653,12.941149711608887],[92.90168762207048,12.940839767456055],[92.90225982666033,12.940890312194767],[92.90228271484392,12.940291404724121]]],[[[92.67150878906256,12.948341369629134],[92.6700`,
  `8972167997,12.948300361633528],[92.67006683349638,12.949480056762866],[92.6723022460938,12.949430465698242]]],[[[92.66895294189447,12.953350067138672],[92.66895294189447,12.953069686889876],[92.66945648193365,12.95310020446783],[92.66979217529303,12.952800750732422]]],[[[92.7,12.99],[92.67,12.78],[92.63,12.88],[92.7,12.99]]],[[[93.00673675537138,12.996899604797363],[93.00673675537138,12.996141433716105],[93.0064544677735,12.995867729187012],[93.0065231323245,12.995249748229924]]],[[[92.988052368164,12.998050689697493],[92.98807525634783,12.997797966003418],[92.98754119873064,12.997797966003418],[92.98754119873064,12.998050689697493]]],[[[92.91249847412138,13.002499580383585],[92.9116821289063,13.002499580383585],[92.91166687011724,13.002778053283748],[92.91084289550798,13.00360107421892]]],[[[92.949722290039,13.021110534668082],[92.94860839843767,13.021110534668082],[92.94860839843767,13.021666526794377],[92.94805908203142,13.022220611572266]]],[[[92.92639160156261,13.024168014526367],[92.92639160156261,13.02333068847679],[92.9269409179688,13.02333068847679],[92.9269409179688,13.023612022399902]]],[[[92.91860961914091,13.040000915527287],[92.91665649414068,13.040000915527287],[92.91500091552729,13.041666984558105],[92.91486358642595,13.041945457458496]]],[[[92.93360900878912,13.049443244934196],[92.93333435058611,13.049443244934196],[92.93305206298834,13.049723625183333],[92.932914733887,13.049862861633244]]],[[[92.91681671142584,13.05789184570341],[92.91613006591825,13.05789184570341],[92.91599273681658,13.058101654052734],[92.91584777832037,13.0585098266601]]],[[[92.73055267334013,13.095690727234114],[92.73069000244146,13.095549583435059],[92.73110961914091,13.095561981201456],[92.73166656494169,13.095001220703125]]],[[[92.71916961669939,13.09889125823986],[92.72027587890625,13.0977792739871],[92.72055816650396,13.097498893737736],[92.72110748291021,13.096390724182186]]],[[[92.7949981689456,13.171110153198299],[92.79528045654314,13.1708345413208],[92.7958297729493`,
  `9,13.1708345413208],[92.79611206054693,13.170554161072005]]],[[[93.0613861083985,13.22138786315918],[93.06096649169939,13.220690727234],[93.05990600585949,13.220971107482967],[93.05970001220709,13.221041679382608]]],[[[93.01667022705072,13.284167289734171],[93.0158309936524,13.283329963684253],[93.01519775390642,13.283332824707315],[93.01491546630888,13.283472061157227]]],[[[93.07450866699236,13.303334236144963],[93.07499694824247,13.303055763244572],[93.07554626464855,13.303060531616438],[93.0761108398438,13.302499771118107]]],[[[93.01867675781256,13.329630851745776],[93.01868438720709,13.329345703124943],[93.0188827514649,13.329351425170898],[93.01889038085943,13.32907962799095]]],[[[92.96806335449236,13.332500457763615],[92.96749877929705,13.332500457763615],[92.96749877929705,13.33278083801298],[92.96722412109403,13.333057403564567]]],[[[93.01611328125017,13.339089393615836],[93.01611328125017,13.338339805603027],[93.0161209106447,13.337931632995662],[93.01580047607428,13.337931632995662]]],[[[93.03749847412126,13.34056186676031],[93.03694152832048,13.34056186676031],[93.036880493164,13.340840339660701],[93.0368041992188,13.341667175293196]]],[[[93.07723999023443,13.364815711975211],[93.07729339599638,13.364725112915039],[93.07785797119169,13.364725112915039],[93.07814025878923,13.364518165588379]]],[[[93.08257293701178,13.36687183380144],[93.0822219848634,13.36687183380144],[93.08167266845732,13.367220878601074],[93.08097076416033,13.36805534362793]]],[[[93.06231689453125,13.38329792022705],[93.06217193603521,13.383020401001147],[93.06196594238287,13.383090019226074],[93.061752319336,13.383227348327807]]],[[[92.86583709716814,13.413610458373967],[92.86611175537115,13.413331985473576],[92.86638641357439,13.413331985473576],[92.86666870117193,13.413057327270565]]],[[[92.81305694580084,13.419722557067985],[92.81361389160162,13.41916656494152],[92.81388854980497,13.419180870056323],[92.81416320800798,13.418890953064192]]],[[[93.09449005126947,13.417631149292163],[9`,
  `3.09462738037138,13.417559623718432],[93.09490966796892,13.417559623718432],[93.09519195556652,13.417770385742415]]],[[[93.07205200195318,13.426081657409952],[93.07198333740229,13.42580795288086],[93.07163238525408,13.425810813903922],[93.07150268554693,13.425671577453613]]],[[[93.09902191162138,13.435761451721476],[93.09957885742199,13.435489654540959],[93.10056304931669,13.435625076294059],[93.1016693115235,13.435556411743391]]],[[[92.84333038330095,13.440832138061808],[92.84333038330095,13.439999580383358],[92.84361267089855,13.43972015380865],[92.84361267089855,13.438334465026799]]],[[[94.27333068847662,13.464444160461483],[94.27333068847662,13.464165687561092],[94.27361297607416,13.463890075683594],[94.27361297607416,13.463061332702694]]],[[[92.87444305419922,13.51220989227295],[92.87444305419922,13.511943817138786],[92.87305450439453,13.510556221008528],[92.87319946289091,13.510418891906795]]],[[[92.91889190673834,13.515569686889876],[92.91916656494169,13.515282630920467],[92.9194412231447,13.515282630920467],[92.91971588134777,13.515000343322754]]],[[[92.91000366210966,13.537221908569506],[92.9119415283206,13.535277366638468],[92.9119415283206,13.534998893737907],[92.91249847412138,13.534440994262638]]],[[[92.87500000000017,13.54083442688011],[92.87638854980474,13.53944396972662],[92.87695312500006,13.539450645446834],[92.87860870361345,13.537779808044547]]],[[[93.00785827636747,13.555362701416243],[93.00758361816412,13.555294990539494],[93.00723266601568,13.555299758911133],[93.0068130493164,13.555229187011719]]],[[[93.05734252929705,13.566250801086653],[93.05734252929705,13.565909385681152],[93.05747985839838,13.565571784973258],[93.05741119384771,13.565291404724292]]],[[[93.03,13.57],[93.03,13.37],[93.09,13.34],[92.95,13.34],[93.07,13.27],[93.03,13.08],[92.97,13.01],[92.89,13.06],[92.94,12.97],[92.84,12.88],[92.79,13.02],[92.84,13.4],[93.03,13.57]]],[[[92.89694213867205,13.601671218872127],[92.89721679687528,13.601392745971907],[92.89778137207043,13.601392`,
  `745971907],[92.89833068847662,13.600830078125]]],[[[93.06388854980474,13.654166221618823],[93.06472015380888,13.653329849243164],[93.06576538085943,13.653126716613883],[93.06749725341803,13.651460647583235]]],[[[93.02361297607428,13.67086124420166],[93.02311706542997,13.67086124420166],[93.02291870117216,13.67127990722662],[93.02311706542997,13.671620368957633]]],[[[93.0158309936524,13.67611217498785],[93.01638793945318,13.675556182861385],[93.01667022705072,13.675560951232853],[93.0169525146485,13.675279617309798]]],[[[93.22442626953142,14.015830993652514],[93.22666931152338,14.013884544372502],[93.22708892822283,14.013261795044173],[93.2271575927735,14.012079238891602]]],[[[93.36666870117182,14.047499656677246],[93.3661193847658,14.046938896179313],[93.36611175537126,14.046668052673454],[93.36583709716803,14.04666996002203]]],[[[93.38360595703153,14.127779960632381],[93.38360595703153,14.127360343933162],[93.38319396972662,14.127078056335392],[93.38223266601568,14.127219200134277]]],[[[93.36624908447294,14.156380653381461],[93.36638641357428,14.156111717224405],[93.36694335937506,14.155559539794922],[93.36694335937506,14.155282020569018]]],[[[93.35694122314447,14.192500114440861],[93.35722351074224,14.19222164154047],[93.3574981689456,14.19222164154047],[93.35813140869158,14.192081451416072]]],[[[93.37027740478544,14.193334579467717],[93.37055206298834,14.19305419921875],[93.37110900878923,14.193060874939192],[93.37194824218761,14.192219734191895]]],[[[93.55055236816423,14.783920288086108],[93.55013275146513,14.783920288086108],[93.5497817993164,14.784132003784237],[93.54928588867193,14.785088539123706]]],[[[93.57083129882818,14.846321105957031],[93.57055664062494,14.84618186950695],[93.57021331787126,14.846240997314453],[93.56986236572266,14.846657752990836]]],[[[93.57221984863293,14.859443664550952],[93.57166290283232,14.85888767242426],[93.57110595703153,14.858889579773063],[93.57083129882818,14.8591699600222]]],[[[93.57274627685553,14.870361328125],[93.5731582`,
  `6416021,14.869879722595329],[93.57315826416021,14.868500709533919],[93.57274627685553,14.868159294128645]]],[[[93.64138793945312,14.902499198913802],[93.64250183105486,14.901391029358024],[93.64250183105486,14.901110649108887],[93.64306640625017,14.900559425354231]]],[[[93.64840698242205,14.934869766235352],[93.64916992187517,14.934440612792969],[93.64944458007818,14.934443473816032],[93.65034484863298,14.934023857116983]]]]}},{"type":"Feature","properties":{"n":"Andhra Pradesh"},"geometry":{"type":"MultiPolygon","coordinates":[[[[80.27458190917997,13.459583282470703],[80.27458190917997,13.459029197692814],[80.27485656738298,13.459031105041618],[80.27485656738298,13.458750724792424]]],[[[80.22735595703142,13.494031906127987],[80.22735595703142,13.493471145629883],[80.22763824462896,13.493471145629883],[80.22763824462896,13.492917060852164]]],[[[80.2323608398438,13.494583129882812],[80.2323608398438,13.494304656982422],[80.23291778564453,13.494304656982422],[80.23291778564453,13.494027137756348]]],[[[80.26541900634777,13.519582748413143],[80.26541900634777,13.519305229187239],[80.26568603515642,13.519309997558707],[80.26568603515642,13.51902961730957]]],[[[80.19264221191423,13.52069568634056],[80.19264221191423,13.520415306091422],[80.19374847412104,13.520421981811467],[80.19374847412104,13.5201416015625]]],[[[80.18486022949224,13.535421371460018],[80.18486022949224,13.535140991211051],[80.18514251709013,13.535140991211051],[80.18514251709013,13.534580230712947]]],[[[80.05346679687506,13.589310646057243],[80.05346679687506,13.589031219482365],[80.05403137207037,13.589031219482365],[80.05403137207037,13.588752746581974]]],[[[80.14902496337896,13.618473052978516],[80.14902496337896,13.618194580078125],[80.1493072509765,13.618194580078125],[80.1493072509765,13.616529464721793]]],[[[80.0970764160158,13.641530990600529],[80.0970764160158,13.641249656677246],[80.09735870361334,13.641249656677246],[80.09735870361334,13.640139579772892]]],[[[80.10652923583996,13.652919769287`,
  `223],[80.10652923583996,13.6520805358889],[80.10624694824236,13.652083396911621],[80.10624694824236,13.651527404785156]]],[[[80.10263824462908,13.677640914916992],[80.10263824462908,13.677360534668196],[80.10402679443365,13.677360534668196],[80.10402679443365,13.677083015441951]]],[[[80.05986022949213,15.199861526489315],[80.05986022949213,15.199582099914835],[80.06041717529325,15.199582099914835],[80.06041717529325,15.19930553436302]]],[[[80.21069335937528,15.501530647277946],[80.21069335937528,15.501251220703068],[80.21098327636719,15.501251220703068],[80.21097564697283,15.500695228576603]]],[[[81.0279159545899,15.765693664551009],[81.0279159545899,15.765416145324707],[81.02874755859403,15.765420913696573],[81.02874755859403,15.76513957977295]]],[[[80.7829132080081,15.837639808655013],[80.7829132080081,15.837080955505485],[80.78319549560553,15.837083816528377],[80.78319549560553,15.836806297302473]]],[[[80.78791809082048,15.843194007873592],[80.78791809082048,15.842915534973201],[80.7884826660158,15.842921257018986],[80.7884826660158,15.842639923095703]]],[[[80.78597259521513,15.8565292358399],[80.78597259521513,15.856250762939737],[80.78624725341803,15.856250762939737],[80.78624725341803,15.85597133636486]]],[[[80.77348327636724,15.861809730529785],[80.77348327636724,15.861251831054915],[80.77375030517607,15.861251831054915],[80.77375030517607,15.860971450805948]]],[[[81.54180908203136,16.355421066284407],[81.54180908203136,16.35514068603527],[81.54207611084001,16.35514068603527],[81.54207611084001,16.354860305786303]]],[[[81.53514099121122,16.355972290039062],[81.53514099121122,16.355693817138672],[81.53541564941423,16.355693817138672],[81.53541564941423,16.35458374023449]]],[[[82.31735229492216,16.576530456543196],[82.31735229492216,16.574579238891772],[82.31708526611334,16.574581146240348],[82.31708526611334,16.57402992248535]]],[[[82.26235961914068,16.67791748046892],[82.26235961914068,16.677640914917106],[82.26264190673857,16.677640914917106],[82.26264190673`,
  `857,16.67736053466797]]],[[[82.29951477050798,16.71433258056635],[82.29957580566412,16.714031219482365],[82.29938507080084,16.71402931213379],[82.29943847656278,16.71412849426298]]],[[[82.30790710449236,16.716529846191634],[82.30790710449236,16.716249465942496],[82.30819702148466,16.716249465942496],[82.30819702148466,16.715970993042106]]],[[[82.31485748291027,16.72597312927246],[82.31485748291027,16.72486114501953],[82.3145828247072,16.72486114501953],[82.3145828247072,16.72347068786621]]],[[[82.33207702636713,16.72486114501953],[82.33207702636713,16.725139617919922],[82.33180236816412,16.725139617919922],[82.33180236816412,16.72541999816906]]],[[[82.33,16.72],[82.31,16.6],[82.26,16.69],[82.33,16.72]]],[[[83.17207336425776,17.56903076171892],[83.17207336425776,17.568750381469954],[83.17236328125006,17.568750381469954],[83.17236328125006,17.56680107116705]]],[[[83.30569458007818,17.68458366394043],[83.30569458007818,17.68347167968767],[83.30541992187517,17.68347167968767],[83.30541992187517,17.683195114135856]]],[[[83.31208038330072,17.684860229492415],[83.31208038330072,17.684030532837028],[83.31124877929693,17.684030532837028],[83.31124877929693,17.683740615844727]]],[[[83.2698593139649,17.70874977111839],[83.2698593139649,17.708190917969034],[83.2687530517581,17.708194732666016],[83.2687530517581,17.708471298218]]],[[[82.3,16.71],[82.17,16.73],[82.31,16.57],[81.94,16.4],[81.72,16.31],[81.37,16.36],[80.97,15.73],[80.82,15.71],[80.81,15.84],[80.69,15.88],[80.27,15.67],[80.08,15.32],[80.05,15.08],[80.06,14.82],[80.2,14.59],[80.12,14.11],[80.32,13.43],[80.15,13.72],[80.14,13.61],[80.11,13.71],[80.05,13.59],[80.31,13.37],[80.23,13.48],[80.01,13.53],[79.93,13.34],[79.72,13.27],[79.74,13.19],[79.67,13.28],[79.58,13.25],[79.43,13.32],[79.37,13.3],[79.42,13.19],[79.31,13.1],[79.22,13.14],[79.15,13.01],[78.98,13.08],[78.92,13.02],[78.88,13.09],[78.7,13.06],[78.61,12.98],[78.55,12.69],[78.48,12.73],[78.45,12.61],[78.37,12.61],[78.19,12.68],[78.24,12.85],[78.35,12.93],[78.45`,
  `,12.85],[78.42,12.97],[78.58,13.26],[78.37,13.32],[78.39,13.58],[78.18,13.56],[78.16,13.65],[78.08,13.64],[78.11,13.85],[77.94,13.82],[77.98,13.95],[77.82,13.93],[77.71,13.73],[77.65,13.78],[77.45,13.68],[77.42,13.84],[77.18,13.86],[77.18,13.92],[77.17,13.75],[76.99,13.74],[77.04,13.93],[76.89,14.16],[77.02,14.17],[77.02,14.05],[77.15,13.99],[77.31,14.02],[77.4,13.88],[77.43,13.97],[77.33,14.02],[77.4,14.1],[77.35,14.12],[77.5,14.15],[77.5,14.26],[77.39,14.32],[77.38,14.19],[77.28,14.33],[77.15,14.34],[77.11,14.21],[76.94,14.24],[76.88,14.39],[76.97,14.48],[76.87,14.47],[76.76,14.6],[76.87,14.94],[76.76,14.97],[76.77,15.06],[77.08,15.0],[77.15,15.12],[77.16,15.26],[76.97,15.49],[77.03,15.63],[77.12,15.64],[77.02,15.83],[77.07,15.9],[77.51,15.92],[77.49,16.25],[77.59,16.34],[77.24,16.47],[77.46,16.58],[77.42,16.66],[77.5,17.01],[77.38,17.22],[77.51,17.43],[77.69,17.49],[77.44,17.58],[77.65,17.97],[77.55,18.05],[77.6,18.28],[77.53,18.44],[77.6,18.55],[77.74,18.55],[77.84,18.81],[77.94,18.82],[77.76,19.03],[77.85,19.09],[77.86,19.3],[77.95,19.34],[78.17,19.24],[78.18,19.41],[78.31,19.46],[78.27,19.66],[78.37,19.78],[78.31,19.91],[78.49,19.79],[78.85,19.76],[78.86,19.66],[78.97,19.65],[78.95,19.55],[79.18,19.46],[79.24,19.61],[79.47,19.5],[79.81,19.57],[79.97,19.4],[79.94,19.17],[79.86,19.1],[79.93,19.02],[79.91,18.81],[80.11,18.68],[80.27,18.72],[80.34,18.59],[80.48,18.63],[80.63,18.52],[80.79,18.25],[80.73,18.17],[80.83,18.23],[80.86,18.13],[80.97,18.17],[81.05,17.78],[81.16,17.85],[81.61,17.82],[82.02,18.06],[82.26,17.98],[82.36,18.13],[82.31,18.2],[82.39,18.31],[82.33,18.32],[82.36,18.41],[82.47,18.54],[82.63,18.23],[82.8,18.44],[82.9,18.36],[83.05,18.38],[83.02,18.44],[83.09,18.54],[83.01,18.64],[83.13,18.77],[83.21,18.72],[83.4,18.83],[83.31,18.99],[83.46,18.95],[83.46,19.07],[83.53,19.01],[83.62,19.15],[83.75,18.92],[83.79,19.01],[83.87,18.82],[84.08,18.74],[84.31,18.78],[84.43,18.91],[84.42,19.01],[84.57,19.07],[84.59,19.01],[84.66,19.07],[84.59,19.12],[84.71,19`,
  `.15],[84.75,19.05],[84.12,18.31],[83.57,18.02],[83.21,17.59],[82.37,17.12],[82.25,16.93],[82.35,16.85],[82.36,16.96],[82.3,16.71]]]]}},{"type":"Feature","properties":{"n":"Arunachal Pradesh"},"geometry":{"type":"Polygon","coordinates":[[[96.16,29.38],[96.24,29.24],[96.39,29.26],[96.11,29.08],[96.17,28.91],[96.53,29.08],[96.48,28.99],[96.62,28.78],[96.26,28.41],[96.4,28.34],[96.66,28.47],[97.0,28.32],[97.09,28.37],[97.4,28.2],[97.31,28.08],[97.42,28.02],[97.39,27.9],[97.26,27.91],[96.9,27.62],[96.91,27.46],[97.15,27.1],[96.87,27.2],[96.8,27.35],[96.62,27.37],[96.52,27.29],[96.1,27.23],[95.73,26.89],[95.53,26.83],[95.42,26.7],[95.24,26.69],[95.2,27.04],[95.46,27.14],[95.52,27.27],[95.89,27.26],[96.02,27.37],[95.85,27.43],[95.88,27.55],[95.76,27.73],[95.98,27.97],[95.61,27.96],[94.46,27.56],[94.25,27.64],[94.26,27.52],[93.81,27.15],[93.84,27.07],[93.49,26.94],[93.02,26.92],[92.66,27.04],[92.59,26.96],[92.11,26.89],[92.02,27.16],[92.04,27.27],[92.12,27.29],[92.02,27.48],[91.65,27.48],[91.56,27.58],[91.64,27.76],[91.55,27.86],[91.82,27.81],[91.92,27.72],[92.21,27.86],[92.32,27.78],[92.56,27.82],[92.74,27.99],[92.69,28.13],[93.22,28.33],[93.18,28.44],[93.34,28.64],[93.93,28.67],[94.21,29.08],[94.56,29.23],[94.63,29.35],[94.8,29.16],[95.41,29.03],[95.55,29.13],[95.54,29.21],[95.78,29.36],[96.08,29.46],[96.16,29.38]]]}},{"type":"Feature","properties":{"n":"Assam"},"geometry":{"type":"MultiPolygon","coordinates":[[[[89.87145233154291,25.53729820251459],[89.8711776733399,25.53695106506376],[89.87565612792969,25.528528213501204],[89.87032318115251,25.5214900970459]]],[[[89.87145233154291,25.53729820251459],[89.87094879150396,25.538642883300895],[89.87320709228533,25.540090560913143],[89.87394714355486,25.54193687438965]]],[[[95.95,27.94],[95.76,27.73],[95.88,27.55],[95.85,27.43],[96.02,27.37],[95.89,27.26],[95.51,27.27],[95.46,27.14],[95.02,26.93],[94.89,26.94],[94.76,26.77],[94.47,26.67],[94.32,26.46],[94.28,26.56],[94.0,26.17],[93.98,25.92],[93.8,25.81],[93.77,25.97],[93.33,`,
  `25.55],[93.46,25.43],[93.47,25.31],[93.25,25.02],[93.2,24.81],[93.11,24.81],[93.04,24.41],[92.83,24.38],[92.77,24.52],[92.47,24.14],[92.42,24.25],[92.21,24.25],[92.3,24.74],[92.24,24.9],[92.49,24.87],[92.42,25.0],[92.48,25.11],[92.8,25.22],[92.78,25.33],[92.57,25.47],[92.65,25.59],[92.57,25.56],[92.39,25.75],[92.16,25.67],[92.23,25.91],[92.16,25.94],[92.3,26.08],[91.92,26.0],[91.82,26.12],[91.67,25.91],[91.58,26.03],[91.47,25.87],[91.53,25.87],[91.33,25.84],[91.22,25.72],[91.2,25.86],[91.0,25.82],[91.03,25.89],[90.94,25.95],[90.62,25.9],[90.58,25.96],[90.51,25.9],[90.48,26.02],[90.12,25.96],[89.89,25.74],[90.02,25.6],[89.87,25.54],[89.81,25.82],[89.89,25.94],[89.69,26.19],[89.72,26.31],[89.86,26.38],[89.86,26.74],[90.13,26.75],[90.21,26.85],[90.41,26.9],[90.7,26.77],[91.69,26.81],[91.86,26.91],[92.06,26.85],[92.59,26.96],[92.66,27.04],[93.02,26.92],[93.66,26.97],[94.26,27.52],[94.25,27.64],[94.46,27.56],[95.61,27.96],[95.95,27.94]]]]}},{"type":"Feature","properties":{"n":"Bihar"},"geometry":{"type":"MultiPolygon","coordinates":[[[[88.1054763793947,26.53903961181652],[88.10504913330072,26.53584861755371],[88.10621643066423,26.536014556884993],[88.10202026367205,26.534389495849723]]],[[[84.12,27.51],[84.3,27.38],[84.62,27.34],[84.69,27.21],[84.64,27.05],[84.96,26.96],[85.02,26.86],[85.2,26.87],[85.21,26.76],[85.64,26.87],[85.85,26.57],[86.03,26.67],[86.33,26.62],[86.73,26.42],[87.07,26.59],[87.09,26.45],[87.34,26.35],[87.47,26.44],[87.61,26.38],[87.89,26.49],[88.03,26.36],[88.11,26.54],[88.23,26.55],[88.18,26.49],[88.28,26.34],[87.96,26.15],[87.8,25.92],[88.05,25.69],[88.07,25.48],[87.93,25.54],[87.78,25.44],[87.84,25.2],[87.58,25.35],[87.48,25.3],[87.47,25.19],[87.32,25.22],[87.29,25.09],[87.15,25.02],[87.05,24.61],[86.93,24.64],[86.91,24.54],[86.78,24.62],[86.6,24.61],[86.45,24.37],[86.28,24.46],[86.32,24.58],[86.13,24.6],[86.05,24.78],[85.95,24.73],[85.74,24.82],[85.66,24.58],[85.28,24.53],[85.09,24.38],[85.08,24.44],[84.9,24.37],[84.8,24.53],[84.66,24.39],[84.52,2`,
  `4.38],[84.49,24.29],[84.29,24.45],[84.29,24.57],[84.11,24.48],[83.99,24.64],[83.87,24.53],[83.5,24.53],[83.54,24.63],[83.39,24.78],[83.32,25.02],[83.35,25.2],[83.84,25.44],[84.09,25.72],[84.29,25.66],[84.33,25.74],[84.49,25.68],[84.63,25.73],[84.53,25.88],[84.05,26.1],[84.01,26.23],[84.16,26.24],[84.17,26.37],[83.9,26.45],[84.08,26.64],[84.41,26.63],[84.23,26.74],[84.24,26.86],[84.05,26.89],[83.92,27.32],[83.83,27.32],[83.91,27.38],[83.87,27.43],[84.12,27.51]]],[[[87.30621337890653,27.84321594238304],[87.30680084228544,27.836589813232422],[87.30617523193365,27.843217849731445],[87.30621337890653,27.84321594238304]]],[[[87.26291656494169,27.850715637207315],[87.25248718261736,27.842866897583008],[87.25118255615251,27.84306144714367],[87.25131988525385,27.843114852905273]]],[[[87.26291656494169,27.850715637207315],[87.26721191406267,27.8501167297365],[87.26628112792974,27.849452972412166],[87.26291656494169,27.850715637207315]]]]}},{"type":"Feature","properties":{"n":"Chandigarh"},"geometry":{"type":"Polygon","coordinates":[[[76.82,30.69],[76.69,30.76],[76.8,30.79],[76.82,30.69]]]}},{"type":"Feature","properties":{"n":"Chhattisgarh"},"geometry":{"type":"Polygon","coordinates":[[[83.33,24.1],[83.51,24.03],[83.56,23.86],[83.7,23.82],[83.77,23.6],[83.94,23.56],[84.01,23.63],[83.97,23.38],[84.07,23.33],[84.03,23.14],[84.15,22.96],[84.19,23.02],[84.37,22.98],[84.38,22.88],[84.22,22.67],[84.01,22.57],[84.0,22.37],[83.62,22.2],[83.53,22.03],[83.58,21.84],[83.47,21.78],[83.42,21.68],[83.48,21.63],[83.38,21.61],[83.33,21.5],[83.4,21.35],[83.27,21.38],[83.19,21.14],[82.64,21.15],[82.46,20.82],[82.35,20.88],[82.32,20.55],[82.43,20.43],[82.39,20.06],[82.71,19.99],[82.71,19.85],[82.59,19.77],[82.59,19.87],[82.44,19.9],[82.34,19.83],[82.23,20.0],[82.02,20.01],[81.94,20.1],[81.87,20.05],[81.85,19.91],[82.06,19.78],[82.02,19.5],[82.18,19.42],[82.16,19.13],[82.24,18.91],[82.08,18.71],[81.89,18.65],[81.95,18.56],[81.74,18.35],[81.53,18.26],[81.38,17.8],[81.16,17.85],[81.04,17.79],[80.9`,
  `7,18.17],[80.86,18.13],[80.83,18.23],[80.73,18.17],[80.79,18.25],[80.73,18.41],[80.49,18.63],[80.34,18.59],[80.24,18.75],[80.35,18.82],[80.27,18.99],[80.38,19.24],[80.57,19.4],[80.61,19.31],[80.75,19.29],[80.85,19.36],[80.79,19.43],[80.89,19.47],[80.66,19.61],[80.54,19.82],[80.39,19.79],[80.5,19.87],[80.41,19.93],[80.52,19.93],[80.55,20.07],[80.39,20.14],[80.38,20.24],[80.62,20.33],[80.62,20.6],[80.48,20.62],[80.58,20.68],[80.54,20.93],[80.42,21.01],[80.46,21.17],[80.67,21.3],[80.72,21.71],[80.81,21.75],[80.91,22.11],[81.0,22.07],[81.11,22.44],[81.32,22.52],[81.4,22.44],[81.62,22.54],[81.76,22.66],[81.77,22.87],[81.94,22.96],[81.94,23.08],[82.15,23.14],[82.19,23.33],[81.98,23.41],[81.92,23.53],[81.61,23.51],[81.57,23.59],[81.69,23.72],[81.61,23.91],[81.78,23.81],[81.92,23.87],[82.52,23.78],[82.8,23.96],[82.95,23.87],[83.13,23.89],[83.33,24.1]]]}},{"type":"Feature","properties":{"n":"Dadra and Nagar Haveli"},"geometry":{"type":"Polygon","coordinates":[[[72.99,20.29],[73.1,20.36],[73.18,20.31],[73.06,20.2],[73.23,20.19],[73.2,20.06],[72.99,20.11],[72.92,20.27],[72.99,20.29]]]}},{"type":"Feature","properties":{"n":"Daman and Diu"},"geometry":{"type":"MultiPolygon","coordinates":[[[[72.86013793945324,20.470960617065543],[72.86340332031278,20.468839645385856],[72.8658981323245,20.467510223388615],[72.86238098144537,20.4622802734375]]],[[[70.88852691650419,20.709762573242244],[70.88853454589872,20.709032058716048],[70.88764190673845,20.709028244018498],[70.88764190673845,20.70930671691889]]],[[[70.95,20.73],[71.0,20.71],[70.89,20.71],[70.95,20.73]]],[[[70.77,20.96],[70.9,20.9],[70.82,20.85],[70.9,20.82],[70.84,20.69],[70.67,20.76],[70.77,20.96]]]]}},{"type":"Feature","properties":{"n":"Delhi"},"geometry":{"type":"Polygon","coordinates":[[[77.22,28.84],[77.34,28.62],[77.24,28.43],[76.84,28.56],[76.93,28.64],[76.94,28.82],[77.08,28.88],[77.22,28.84]]]}},{"type":"Feature","properties":{"n":"Goa"},"geometry":{"type":"MultiPolygon","coordinates":[[[[73.78180694580107,15.355693`,
  `817138672],[73.78180694580107,15.355416297912598],[73.78235626220732,15.355420112609977],[73.78235626220732,15.35513973236101]]],[[[73.79651641845703,15.379030227661076],[73.79651641845703,15.378751754760685],[73.79736328125006,15.378751754760685],[73.79736328125006,15.378471374511719]]],[[[73.86429595947271,15.408480644226074],[73.86429595947271,15.408190727234171],[73.86541748046892,15.408193588256836],[73.86541748046892,15.407361984252873]]],[[[73.88,15.78],[74.0,15.61],[74.26,15.65],[74.34,15.29],[74.26,15.26],[74.3,15.04],[74.21,14.92],[74.04,14.92],[73.91,15.08],[73.89,15.35],[73.78,15.41],[73.9,15.41],[73.79,15.46],[73.68,15.72],[73.88,15.78]]]]}},{"type":"Feature","properties":{"n":"Gujarat"},"geometry":{"type":"MultiPolygon","coordinates":[[[[70.86096954345703,20.752918243408203],[70.86096954345703,20.75263977050804],[70.86152648925798,20.75263977050804],[70.86152648925798,20.752359390258846]]],[[[72.84597015380865,20.763200759887923],[72.84597015380865,20.762929916381893],[72.84625244140653,20.762929916381893],[72.84625244140653,20.76263999938982]]],[[[71.38847351074213,20.867084503173942],[71.38847351074213,20.86652755737299],[71.38819122314459,20.866529464721964],[71.38819122314459,20.86625289917015]]],[[[71.51625061035185,20.914304733276367],[71.51625061035185,20.914028167724553],[71.51653289794928,20.914028167724553],[71.51653289794928,20.91374969482439]]],[[[71.64901733398432,20.97792053222679],[71.64901733398432,20.977359771728516],[71.64930725097662,20.977361679077262],[71.64930725097662,20.976528167724723]]],[[[71.68653106689459,20.996528625488452],[71.68653106689459,20.996248245239258],[71.68681335449236,20.996248245239258],[71.68680572509783,20.9959716796875]]],[[[71.70375061035185,20.999582290649528],[71.70375061035185,20.999305725097713],[71.70403289794928,20.999309539794922],[71.70403289794928,20.99903106689453]]],[[[71.71041870117216,20.999582290649528],[71.71041870117216,20.999305725097713],[71.71153259277372,20.999309539794922],[71.71153259`,
  `277372,20.99903106689453]]],[[[72.64763641357428,21.076248168945256],[72.64763641357428,21.075418472290096],[72.64791870117188,21.075418472290096],[72.64791870117188,21.07513809204113]]],[[[72.6793060302735,21.09875106811546],[72.6793060302735,21.098190307617188],[72.67958068847656,21.09819412231451],[72.67958068847656,21.097959518432617]]],[[[72.67208099365263,21.115140914916992],[72.67208099365263,21.114311218261776],[72.67236328125017,21.114311218261776],[72.67236328125017,21.113470077514705]]],[[[72.70207977294922,21.1223602294923],[72.70207977294922,21.120700836181697],[72.70236206054693,21.120700836181697],[72.70236206054693,21.117908477783146]]],[[[72.67652893066406,21.155700683593807],[72.67652893066406,21.155418395996094],[72.67764282226591,21.155418395996094],[72.67764282226591,21.155139923095703]]],[[[72.10291290283214,21.27431106567377],[72.10291290283214,21.274030685424805],[72.10346984863287,21.274030685424805],[72.10346984863287,21.272640228271484]]],[[[72.58790588378912,21.339309692382812],[72.58790588378912,21.337921142578068],[72.58763885498047,21.337921142578068],[72.58763885498047,21.336811065673885]]],[[[72.58319091796903,21.365419387817496],[72.58319091796903,21.365140914917106],[72.58374786376959,21.365140914917106],[72.58374786376959,21.364570617675838]]],[[[72.60041809082031,21.387081146240234],[72.60041809082031,21.383750915527344],[72.60013580322271,21.383750915527344],[72.60013580322271,21.379301071166992]]],[[[72.62819671630871,21.417360305786133],[72.62819671630871,21.416810989379883],[72.62847137451189,21.416810989379883],[72.62847137451189,21.41625022888195]]],[[[72.635971069336,21.41764068603527],[72.635971069336,21.417360305786133],[72.63680267334013,21.417360305786133],[72.63680267334013,21.416810989379883]]],[[[72.67597198486345,21.446809768676815],[72.67597198486345,21.445980072021428],[72.67624664306646,21.445980072021428],[72.67624664306646,21.444311141967717]]],[[[69.7242965698245,21.56402969360363],[69.7242965698245,21.563751`,
  `220703068],[69.72458648681646,21.563751220703068],[69.72458648681646,21.5634708404541]]],[[[69.7284698486331,21.612083435058594],[69.7284698486331,21.61180496215843],[69.72875213623064,21.61181259155296],[69.72875213623064,21.611520767211914]]],[[[72.35319519042997,21.613470077514762],[72.35319519042997,21.61291694641119],[72.35375213623075,21.612922668457315],[72.35375213623075,21.612640380859375]]],[[[72.58458709716797,21.629030227661076],[72.58458709716797,21.627082824706974],[72.58430480957037,21.627082824706974],[72.58430480957037,21.626249313354606]]],[[[72.60930633544928,21.62874984741211],[72.60930633544928,21.627920150756893],[72.6090164184572,21.627920150756893],[72.6090164184572,21.627082824706974]]],[[[72.61180877685575,21.632085800170955],[72.61180877685575,21.631526947021598],[72.61152648925798,21.63153076171875],[72.61152648925798,21.631250381469783]]],[[[72.61708068847662,21.638471603393498],[72.61708068847662,21.63763809204113],[72.61680603027338,21.63763809204113],[72.61680603027338,21.63735961914074]]],[[[72.595703125,21.639030456543026],[72.595703125,21.63875007629406],[72.59597015380888,21.63875007629406],[72.59596252441418,21.63763809204113]]],[[[72.61958312988287,21.639583587646428],[72.61958312988287,21.639305114746264],[72.62014770507818,21.639312744140796],[72.62014770507818,21.639030456543026]]],[[[72.60236358642595,21.640970230102766],[72.60236358642595,21.64069366455078],[72.60263824462902,21.64069366455078],[72.60263824462902,21.639860153198242]]],[[[72.72264099121122,21.665971755981502],[72.72264099121122,21.665695190429915],[72.72374725341803,21.665695190429915],[72.72374725341803,21.665416717529354]]],[[[72.27430725097673,21.749582290649357],[72.27430725097673,21.74930572509777],[72.27458190917997,21.749309539794922],[72.27458190917997,21.74903106689453]]],[[[72.35485839843756,21.943199157714844],[72.35485839843756,21.94292068481468],[72.35514068603533,21.94292068481468],[72.35514068603533,21.94235992431635]]],[[[72.21402740478533,22`,
  `.005420684814624],[72.21402740478533,22.004859924316463],[72.21375274658232,22.004861831665266],[72.21375274658232,22.004583358764876]]],[[[72.47264099121111,22.208194732666016],[72.47264099121111,22.20791435241705],[72.47319793701172,22.207920074463175],[72.47319793701172,22.20763969421381]]],[[[72.38430786132807,22.21569442749046],[72.38430786132807,22.21541595459007],[72.38540649414091,22.21541976928728],[72.38540649414091,22.215139389038086]]],[[[72.37069702148443,22.23513984680187],[72.37069702148443,22.234029769897518],[72.37040710449236,22.234029769897518],[72.37040710449236,22.233190536498967]]],[[[69.31041717529291,22.30625152587902],[69.31041717529291,22.30596923828125],[69.31069183349615,22.30597305297863],[69.31069183349615,22.305137634277287]]],[[[69.45263671875006,22.358194351196403],[69.45263671875006,22.357915878296012],[69.45319366455084,22.357915878296012],[69.45319366455084,22.35763740539545]]],[[[69.18402862548828,22.367639541626204],[69.18402862548828,22.367361068725813],[69.1848602294923,22.367361068725813],[69.1848602294923,22.367080688476847]]],[[[69.19541931152344,22.374584197998274],[69.19541931152344,22.374305725097713],[69.19596862792997,22.374309539795092],[69.19596862792997,22.37235832214361]]],[[[69.21318817138689,22.384859085083065],[69.21318817138689,22.3845806121829],[69.21402740478521,22.384582519531307],[69.21402740478521,22.384307861328068]]],[[[69.2009582519533,22.386251449585018],[69.2009582519533,22.385690689086857],[69.20069122314464,22.385694503784407],[69.20069122314464,22.384859085083065]]],[[[69.33541870117188,22.389030456543082],[69.33541870117188,22.388750076294116],[69.33598327636713,22.388750076294116],[69.3359756469726,22.388471603393725]]],[[[69.48319244384794,22.39874839782709],[69.48319244384794,22.3984699249267],[69.48374938964872,22.398471832275504],[69.48374938964872,22.39819526672369]]],[[[69.28013610839861,22.417921066284407],[69.28013610839861,22.41764068603527],[69.28041839599621,22.41764068603527],[69.2804`,
  `1839599621,22.417360305786303]]],[[[69.27931213378935,22.420141220092773],[69.27931213378935,22.419860839843977],[69.27958679199219,22.419860839843977],[69.27958679199219,22.41930961608898]]],[[[69.14208221435553,22.45763969421415],[69.14208221435553,22.457069396972884],[69.14180755615229,22.4570827484132],[69.14180755615229,22.455608367919922]]],[[[69.62763977050798,22.459583282470703],[69.62763977050798,22.459304809570312],[69.6281967163086,22.459304809570312],[69.6281967163086,22.459028244018498]]],[[[69.30208587646501,22.474029541015852],[69.30208587646501,22.473470687866495],[69.30236053466825,22.47347259521507],[69.30236053466825,22.47319412231468]]],[[[69.13680267334013,22.477638244628906],[69.13680267334013,22.477359771728743],[69.13735961914068,22.47736167907715],[69.13735961914068,22.477083206176758]]],[[[69.08902740478533,22.490694046020735],[69.08902740478533,22.490419387817553],[69.0893020629884,22.490430831909237],[69.0893020629884,22.490140914916992]]],[[[69.3242874145509,22.52763938903837],[69.3242874145509,22.52736091613781],[69.32485961914074,22.52736091613781],[69.32485961914074,22.527080535888842]]],[[[69.94486236572283,22.53236007690458],[69.94486236572283,22.532083511352766],[69.94569396972662,22.532083511352766],[69.94569396972662,22.531805038452205]]],[[[69.4051361083985,22.532640457153377],[69.4051361083985,22.532079696655217],[69.4054183959961,22.532083511352766],[69.4054183959961,22.530971527099666]]],[[[69.95735931396513,22.535972595214844],[69.95735931396513,22.53541755676264],[69.95764160156267,22.535419464111442],[69.95764160156267,22.535142898559627]]],[[[69.96041870117216,22.54375076293951],[69.96041870117216,22.543470382690714],[69.96097564697294,22.54347229003929],[69.96097564697294,22.5431938171389]]],[[[69.95207977294939,22.551250457763786],[69.95207977294939,22.55097007751482],[69.95236206054693,22.55097389221197],[69.95236206054693,22.55069541931158]]],[[[69.91874694824224,22.553195953369084],[69.91874694824224,22.5529174804686`,
  `93],[69.91902923584013,22.552919387817496],[69.91902923584013,22.552640914917106]]],[[[70.02430725097685,22.553195953369084],[70.02430725097685,22.552917480468693],[70.02458190917986,22.552919387817496],[70.02458190917986,22.55181121826172]]],[[[70.01125335693365,22.55375099182129],[70.01125335693365,22.55346107482916],[70.011528015137,22.5534725189209],[70.011528015137,22.553195953369084]]],[[[70.02347564697271,22.5584716796875],[70.02347564697271,22.558195114135685],[70.0240325927735,22.55820083618164],[70.0240325927735,22.557920455932845]]],[[[70.03958129882841,22.567920684814453],[70.03958129882841,22.567640304565487],[70.03985595703125,22.567640304565487],[70.03985595703125,22.56735992431669]]],[[[70.0445861816408,22.572359085083292],[70.0445861816408,22.5720806121829],[70.0448608398438,22.572082519531477],[70.0448608398438,22.571805953979492]]],[[[70.18180847167974,22.58374977111822],[70.18180847167974,22.583469390869254],[70.18208312988276,22.58347129821783],[70.18208312988276,22.583194732666016]]],[[[70.00903320312528,22.59320068359375],[70.00903320312528,22.592920303344954],[70.0095825195313,22.592920303344954],[70.0095825195313,22.592630386352482]]],[[[70.19040679931646,22.599859237670955],[70.19040679931646,22.599580764770565],[70.19069671630876,22.59958267211914],[70.19069671630876,22.599306106567326]]],[[[69.94847106933611,22.606250762939453],[69.94847106933611,22.605970382690657],[69.94875335693371,22.605972290039062],[69.94875335693371,22.605695724487248]]],[[[70.21597290039074,22.64681053161644],[70.21597290039074,22.6465301513673],[70.21624755859392,22.6465301513673],[70.21624755859392,22.646249771118164]]],[[[70.2356948852539,22.684583663940487],[70.2356948852539,22.684305191040096],[70.23596954345709,22.68431091308605],[70.23596954345709,22.684030532836914]]],[[[70.2426376342774,22.684583663940487],[70.2426376342774,22.684305191040096],[70.2437515258789,22.68431091308605],[70.2437515258789,22.683202743530273]]],[[[70.2468032836914,22.6918048858642`,
  `],[70.2468032836914,22.69152641296381],[70.24736022949236,22.691528320312614],[70.24736022949236,22.691249847412223]]],[[[70.24402618408232,22.7201385498048],[70.24402618408232,22.719020843505916],[70.24430847167986,22.719030380249023],[70.24430847167986,22.717636108398494]]],[[[69.64263916015653,22.764862060546875],[69.64263916015653,22.764583587646484],[69.64402770996094,22.764583587646484],[69.64402770996094,22.764305114746094]]],[[[69.63652801513683,22.779861450195426],[69.63652801513683,22.77958488464361],[69.63680267334001,22.77958488464361],[69.63680267334001,22.779306411743278]]],[[[70.4551391601563,22.995700836181584],[70.4551391601563,22.994300842285156],[70.4548645019533,22.99430465698248],[70.4548645019533,22.991527557373217]]],[[[70.44152832031267,23.049583435058537],[70.44152832031267,23.048196792602596],[70.44125366210966,23.048196792602596],[70.44125366210966,23.04763793945324]]],[[[70.448471069336,23.05208396911621],[70.448471069336,23.051805496216048],[70.44875335693376,23.051811218261776],[70.44875335693376,23.051250457763672]]],[[[70.45236206054688,23.052360534668196],[70.45236206054688,23.05208015441906],[70.45207977294928,23.05208396911621],[70.45207977294928,23.051528930664062]]],[[[70.45903015136713,23.057640075683594],[70.45903015136713,23.057081222534407],[70.45930480957037,23.057081222534407],[70.45930480957037,23.056528091430664]]],[[[70.45207977294928,23.060695648193644],[70.45207977294928,23.060417175293082],[70.45236206054688,23.060420989990234],[70.45236206054688,23.0598602294923]]],[[[70.4695816040039,23.06125068664562],[70.4695816040039,23.060970306396484],[70.47013854980486,23.06097221374506],[70.47013854980486,23.060695648193644]]],[[[70.48236083984375,23.06541824340843],[70.48236083984375,23.064859390258903],[70.48263549804716,23.06486129760748],[70.48263549804716,23.06374931335472]]],[[[68.60901641845709,23.23125267028837],[68.60901641845709,23.23097038269043],[68.6095809936524,23.23097038269043],[68.6095809936524,23.23069381713`,
  `8615]]],[[[68.59430694580084,23.262083053588867],[68.59430694580084,23.26180648803711],[68.59485626220709,23.261810302734432],[68.59485626220709,23.261529922485295]]],[[[68.65847015380888,23.271249771118278],[68.65847015380888,23.27096939086914],[68.6587524414063,23.270971298217717],[68.6587524414063,23.2706947326663]]],[[[68.62874603271484,23.290140151977482],[68.62874603271484,23.28957939147972],[68.62902832031256,23.2895832061767],[68.62902832031256,23.289028167724723]]],[[[68.7051391601563,23.311809539794922],[68.7051391601563,23.31153106689453],[68.70597076416044,23.31153106689453],[68.70597076416044,23.311252593994368]]],[[[68.55819702148455,23.313751220703068],[68.55819702148455,23.3134708404541],[68.55847167968756,23.31347465515148],[68.55847167968756,23.31319236755371]]],[[[68.64263916015653,23.31402969360346],[68.64263916015653,23.313751220703068],[68.64290618896501,23.313751220703068],[68.64290618896501,23.3134708404541]]],[[[68.63263702392584,23.317640304565487],[68.63263702392584,23.317079544067383],[68.63291931152372,23.317083358764933],[68.63291931152372,23.316249847412166]]],[[[68.63986206054688,23.31847190856928],[68.63986206054688,23.318195343017692],[68.64013671875028,23.318210601806754],[68.64013671875028,23.317920684814453]]],[[[68.58847045898466,23.319030761718807],[68.58847045898466,23.31875038146967],[68.59041595459001,23.31875038146967],[68.59041595459001,23.318470001220703]]],[[[68.63181304931658,23.321250915527344],[68.63180541992205,23.320138931274414],[68.63207244873053,23.32014083862299],[68.63207244873053,23.319311141968]]],[[[68.62708282470703,23.321811676025675],[68.62708282470703,23.321529388427734],[68.62763977050798,23.321529388427734],[68.62763977050798,23.321250915527344]]],[[[68.62680816650419,23.325971603393555],[68.62680816650419,23.325693130493164],[68.62763977050798,23.325700759887923],[68.62763977050798,23.32542037963873]]],[[[68.5420761108399,23.341529846191463],[68.5420761108399,23.341249465942496],[68.54235839843767,23.`,
  `341249465942496],[68.54235839843767,23.339021682739258]]],[[[68.55014038085966,23.341529846191463],[68.55014038085966,23.341249465942496],[68.55042266845709,23.341249465942496],[68.55041503906256,23.340974807739315]]],[[[68.55680847167997,23.34181022644043],[68.55680847167997,23.341670989990348],[68.55680847167997,23.341527938842887],[68.55625152587885,23.341529846191463]]],[[[68.50597381591803,23.342361450195256],[68.50597381591803,23.34208488464367],[68.50624847412138,23.342090606689624],[68.50624847412138,23.341529846191463]]],[[[68.52513885498075,23.344030380248967],[68.52513885498075,23.34375],[68.52902984619158,23.34375],[68.52902984619158,23.343469619751204]]],[[[68.5637512207033,23.34486198425293],[68.5637512207033,23.344583511352766],[68.56430816650408,23.344583511352766],[68.56430816650408,23.34430694580078]]],[[[68.6315307617188,23.35180473327665],[68.6315307617188,23.351528167724837],[68.63181304931658,23.351530075073242],[68.63181304931658,23.350961685180778]]],[[[68.47319793701178,23.35680961608881],[68.47319793701178,23.35653114318842],[68.47347259521479,23.35653114318842],[68.47347259521479,23.356250762939453]]],[[[68.57347106933611,23.360418319702262],[68.57347106933611,23.360130310058594],[68.57375335693388,23.3601398468017],[68.57375335693388,23.35986137390131]]],[[[68.59791564941412,23.360971450805664],[68.59791564941412,23.360694885254077],[68.5990295410158,23.360694885254077],[68.5990295410158,23.360416412353516]]],[[[68.58902740478544,23.37431144714384],[68.58902740478544,23.3740291595459],[68.58957672119152,23.3740291595459],[68.58957672119152,23.373750686645508]]],[[[68.54070281982428,23.377639770507756],[68.54069519042974,23.377361297607365],[68.5409698486331,23.377361297607365],[68.5409698486331,23.377082824706974]]],[[[68.50291442871094,23.383472442626896],[68.50291442871094,23.38319587707531],[68.50319671630888,23.38319587707531],[68.50319671630888,23.382638931274528]]],[[[68.50458526611345,23.38458251953125],[68.50458526611345,23.384307`,
  `86132824],[68.50485992431646,23.38430786132824],[68.50485992431646,23.383750915527287]]],[[[68.53624725341814,23.385419845580998],[68.53624725341814,23.384580612182674],[68.53652954101568,23.38458251953125],[68.53652954101568,23.383750915527287]]],[[[68.57930755615263,23.385419845580998],[68.57930755615263,23.38513946533203],[68.58013916015642,23.38513946533203],[68.58013916015642,23.38486099243164]]],[[[68.53514099121111,23.38763809204113],[68.53514099121111,23.387069702148665],[68.53485870361357,23.38708305358915],[68.53485870361357,23.38652992248535]]],[[[68.55401611328142,23.40403175354021],[68.55401611328142,23.40374946594244],[68.55652618408209,23.40374946594244],[68.55652618408209,23.403190612793082]]],[[[68.53736114501982,23.40486145019537],[68.53736114501982,23.404581069946232],[68.54165649414068,23.404581069946232],[68.54208374023449,23.404581069946232]]],[[[68.46098327636724,23.405141830444563],[68.46098327636724,23.404859542846793],[68.46125030517607,23.40486145019537],[68.46125030517607,23.404581069946232]]],[[[68.52347564697283,23.404581069946232],[68.52347564697283,23.404027938843],[68.52458190917997,23.40403175354021],[68.52458190917997,23.403469085693473]]],[[[68.47097015380888,23.40570068359392],[68.47097015380888,23.40542984008789],[68.47235870361345,23.40542984008789],[68.47235870361345,23.404859542846793]]],[[[68.42986297607422,23.407085418701286],[68.42986297607422,23.406803131103516],[68.43096923828142,23.406810760498274],[68.43096923828142,23.40653038024908]]],[[[68.46319580078142,23.409030914306584],[68.46319580078142,23.406810760498274],[68.46347045898443,23.406810760498274],[68.46347045898443,23.40625]]],[[[68.40902709960955,23.409309387206974],[68.40902709960955,23.409030914306584],[68.4092864990235,23.409030914306584],[68.40930938720709,23.40847015380865]]],[[[68.55764007568376,23.408750534057617],[68.55764007568376,23.408180236816577],[68.55735778808622,23.40819549560547],[68.55735778808622,23.407638549804688]]],[[[68.4145812988283,23.4`,
  `0986061096197],[68.4145812988283,23.409580230713004],[68.4148635864259,23.40958595275879],[68.4148635864259,23.409305572509822]]],[[[68.46069335937494,23.412639617919865],[68.46069335937494,23.412361145019474],[68.46180725097685,23.412361145019474],[68.46180725097685,23.412080764770508]]],[[[68.549575805664,23.41374969482422],[68.549575805664,23.41319084167486],[68.54930877685553,23.41319465637224],[68.54930877685553,23.41291618347168]]],[[[68.40042114257807,23.421249389648494],[68.40041351318388,23.420974731445312],[68.4006958007813,23.420974731445312],[68.4006958007813,23.420415878295955]]],[[[68.40208435058605,23.423196792602766],[68.40208435058605,23.422639846801815],[68.40235900878923,23.422639846801815],[68.40235900878923,23.421810150146428]]],[[[68.39986419677734,23.428472518921183],[68.39986419677734,23.428194046020792],[68.40013885498053,23.428194046020792],[68.40013885498053,23.427917480468977]]],[[[68.50180816650396,23.432081222534237],[68.50180816650396,23.431249618530273],[68.50152587890625,23.431249618530273],[68.50152587890625,23.430690765380916]]],[[[68.51680755615251,23.43292045593256],[68.51680755615251,23.432640075683594],[68.51708221435553,23.432640075683594],[68.51708221435553,23.431531906128214]]],[[[68.50068664550787,23.43625068664545],[68.50068664550787,23.435970306396484],[68.50096893310564,23.43597221374506],[68.50096893310564,23.435417175293082]]],[[[68.50125122070318,23.443750381469727],[68.50125122070318,23.443471908569336],[68.50208282470697,23.443471908569336],[68.50208282470697,23.443195343017578]]],[[[68.50125122070318,23.453479766845874],[68.50125122070318,23.452920913696516],[68.50152587890625,23.452920913696516],[68.50152587890625,23.452360153198185]]],[[[68.50681304931669,23.45654106140148],[68.50681304931669,23.456249237060604],[68.50708007812517,23.456249237060604],[68.50708007812517,23.455970764160213]]],[[[68.40791320800798,23.45792007446289],[68.40791320800798,23.457359313964957],[68.40820312500028,23.457359313964957],[68.40`,
  `819549560575,23.45708274841337]]],[[[68.49903106689447,23.475973129272745],[68.49903106689447,23.475414276123217],[68.49931335449224,23.475419998168945],[68.49931335449224,23.474029541015625]]],[[[68.47,23.48],[68.48,23.4],[68.47,23.46],[68.42,23.42],[68.47,23.48]]],[[[68.49846649169916,23.48903083801298],[68.49846649169916,23.48847007751465],[68.49819183349615,23.488473892212028],[68.49819183349615,23.487916946411246]]],[[[68.50653076171892,23.492649078369368],[68.50653076171892,23.492361068725643],[68.50736236572271,23.492361068725643],[68.50736236572271,23.492080688476506]]],[[[68.510971069336,23.492649078369368],[68.510971069336,23.492361068725643],[68.51152801513678,23.492361068725643],[68.51152801513678,23.49125099182129]]],[[[68.48680877685575,23.495418548583928],[68.48680877685575,23.49513816833496],[68.48707580566423,23.49513816833496],[68.48707580566423,23.49485969543457]]],[[[68.46652984619146,23.49792289733898],[68.46652984619146,23.497642517090014],[68.46708679199224,23.497642517090014],[68.46708679199224,23.497360229492244]]],[[[68.4373626708985,23.500419616699276],[68.4373626708985,23.500141143799112],[68.43791961669928,23.500141143799112],[68.43791961669928,23.499860763549748]]],[[[68.48069763183622,23.501251220703068],[68.48069763183622,23.5009708404541],[68.48124694824247,23.50097465515148],[68.48124694824247,23.50069236755371]]],[[[68.46791839599638,23.524032592773494],[68.46791839599638,23.523202896118278],[68.46819305419939,23.523202896118278],[68.46819305419939,23.52292251586914]]],[[[68.47513580322277,23.528760910034407],[68.47513580322277,23.528470993041935],[68.47597503662126,23.528474807739485],[68.47597503662126,23.52791404724138]]],[[[68.47347259521479,23.537082672119368],[68.47347259521479,23.536527633666992],[68.47374725341803,23.536529541015568],[68.47374725341803,23.5362491607666]]],[[[68.4823608398438,23.550422668457145],[68.4823608398438,23.54986190795921],[68.48263549804682,23.54986190795921],[68.48263549804682,23.54958343505882]]]`,
  `,[[[68.4793090820313,23.555419921874943],[68.4793090820313,23.554861068725586],[68.47957611083979,23.554861068725586],[68.47957611083979,23.554309844970987]]],[[[68.22347259521501,23.586250305175838],[68.22347259521501,23.5859699249267],[68.22569274902372,23.585971832275675],[68.22569274902372,23.58569526672386]]],[[[68.25514221191423,23.590139389038086],[68.25514221191423,23.589860916137695],[68.25541687011747,23.589860916137695],[68.25541687011747,23.589029312133732]]],[[[68.2162475585938,23.59124946594244],[68.2162475585938,23.590690612792912],[68.21652984619169,23.59069442749029],[68.21652984619169,23.590139389038086]]],[[[68.4820861816408,23.596809387206974],[68.4820861816408,23.59653091430681],[68.4823608398438,23.59653091430681],[68.4823608398438,23.596250534057617]]],[[[68.4584732055664,23.600418090820256],[68.4584732055664,23.600139617919865],[68.4615325927735,23.600139617919865],[68.4615249633789,23.599861145019474]]],[[[68.4820861816408,23.60653114318876],[68.4820861816408,23.60642051696783],[68.4820861816408,23.606250762939396],[68.48227691650408,23.606250762939396]]],[[[68.45625305175793,23.624860763549805],[68.45625305175793,23.624580383300838],[68.45708465576172,23.624584197998047],[68.45708465576172,23.624307632446232]]],[[[68.48458099365251,23.62791824340826],[68.48458099365251,23.62763977050787],[68.48680877685575,23.62763977050787],[68.48680877685575,23.627359390258732]]],[[[68.4779129028322,23.722360610961857],[68.4779129028322,23.722078323364485],[68.47902679443376,23.72208404541027],[68.47902679443376,23.72180557250988]]],[[[68.44957733154308,23.73233985900879],[68.44958496093778,23.731525421142692],[68.4498596191408,23.731531143188647],[68.4498596191408,23.731809616089038]]],[[[68.4673614501956,23.739860534667912],[68.4673614501956,23.739580154418945],[68.46791839599638,23.73958206176775],[68.46791839599638,23.739305496215934]]],[[[68.48680877685575,23.74597167968767],[68.48680877685575,23.745136260986328],[68.48652648925787,23.745140075683878`,
  `],[68.48652648925787,23.743190765380803]]],[[[68.21652984619169,23.7793102264406],[68.21652984619169,23.77874946594244],[68.21736145019548,23.77874946594244],[68.21736145019548,23.778480529785384]]],[[[68.34931182861322,23.800140380859546],[68.34931182861322,23.799030303955362],[68.34902954101568,23.799030303955362],[68.34902954101568,23.793191909790266]]],[[[68.36,23.81],[68.43,23.79],[68.39,23.65],[68.2,23.6],[68.31,23.65],[68.23,23.64],[68.36,23.81]]],[[[68.60514068603533,23.80958557128912],[68.60514068603533,23.809303283691577],[68.60569763183611,23.809310913085938],[68.60569763183611,23.808750152588175]]],[[[68.59652709960955,23.812641143799],[68.59652709960955,23.812080383300838],[68.59625244140636,23.812084197998047],[68.59625244140636,23.811807632446232]]],[[[68.30790710449247,23.823749542236328],[68.30790710449247,23.823471069336165],[68.30958557128935,23.823474884033317],[68.30958557128935,23.823196411132756]]],[[[68.5,23.83],[68.52,23.75],[68.44,23.74],[68.5,23.83]]],[[[68.70707702636747,23.851249694824162],[68.70707702636747,23.850971221924],[68.70874786376959,23.850973129272575],[68.70874786376959,23.85069656372076]]],[[[68.69930267333979,23.853200912475813],[68.69930267333979,23.852920532226676],[68.70014190673834,23.852920532226676],[68.70014190673834,23.85264015197771]]],[[[68.53320312500017,23.873750686645792],[68.53319549560564,23.872638702392635],[68.53347015380865,23.87264060974144],[68.53347015380865,23.87236022949247]]],[[[68.4,23.88],[68.43,23.81],[68.33,23.79],[68.4,23.88]]],[[[68.24819183349638,23.88042068481451],[68.24819183349638,23.880140304565714],[68.24931335449247,23.880140304565714],[68.24931335449247,23.87985992431635]]],[[[68.44930267334001,23.938472747802848],[68.44930267334001,23.938194274902457],[68.45069122314459,23.938194274902457],[68.45069122314459,23.937915802002067]]],[[[68.54,23.95],[68.59,23.92],[68.52,23.86],[68.54,23.95]]],[[[68.52569580078153,23.949529647827376],[68.52569580078153,23.949306488037166],[68.52597045898455`,
  `,23.94930076599121],[68.52597045898455,23.948472976684798]]],[[[68.48,23.99],[68.52,23.92],[68.44,23.85],[68.48,23.99]]],[[[68.43,24.0],[68.24,23.68],[68.21,23.83],[68.43,24.0]]],[[[72.1,24.64],[72.35,24.62],[72.25,24.58],[72.44,24.5],[72.46,24.41],[72.54,24.51],[72.7,24.46],[72.73,24.36],[72.92,24.33],[73.01,24.48],[73.1,24.49],[73.08,24.39],[73.23,24.36],[73.08,24.18],[73.25,24.01],[73.37,24.13],[73.42,23.93],[73.36,23.79],[73.51,23.7],[73.51,23.62],[73.66,23.62],[73.63,23.45],[73.83,23.45],[73.89,23.34],[73.96,23.38],[74.11,23.29],[74.13,23.18],[74.25,23.19],[74.36,22.93],[74.48,22.86],[74.38,22.64],[74.27,22.64],[74.15,22.52],[74.04,22.54],[74.12,22.42],[74.19,22.48],[74.29,22.39],[74.19,22.32],[74.07,22.36],[74.18,22.09],[74.1,22.02],[74.15,21.96],[73.81,21.82],[73.9,21.67],[73.79,21.63],[73.86,21.5],[74.31,21.57],[74.33,21.5],[74.07,21.48],[73.95,21.4],[73.95,21.3],[73.83,21.27],[73.82,21.17],[73.59,21.17],[73.91,20.98],[73.95,20.74],[73.67,20.56],[73.45,20.71],[73.4,20.64],[73.5,20.54],[73.39,20.39],[73.43,20.21],[73.31,20.21],[73.26,20.12],[73.18,20.21],[73.07,20.16],[73.18,20.29],[73.11,20.36],[72.92,20.28],[72.97,20.21],[72.74,20.14],[72.78,20.33],[72.88,20.38],[72.89,20.75],[72.72,21.14],[72.63,21.08],[72.65,21.23],[72.59,21.28],[72.74,21.55],[72.63,21.49],[72.6,21.55],[72.84,21.67],[72.54,21.66],[72.57,21.82],[72.5,21.96],[72.58,22.2],[72.76,22.17],[72.92,22.28],[72.54,22.28],[72.49,22.2],[72.36,22.38],[72.42,22.23],[72.36,22.27],[72.34,22.12],[72.29,22.2],[72.28,21.93],[72.24,22.05],[72.3,22.11],[72.17,22.04],[72.22,21.96],[72.15,21.98],[72.25,21.9],[72.26,21.74],[72.18,21.82],[72.31,21.63],[72.08,21.3],[72.11,21.2],[71.05,20.73],[70.87,20.71],[70.9,20.82],[70.82,20.85],[70.89,20.95],[70.74,20.99],[70.67,20.75],[70.1,21.1],[69.71,21.53],[69.74,21.65],[69.7,21.59],[69.63,21.64],[69.71,21.54],[69.59,21.62],[68.94,22.31],[69.07,22.48],[69.07,22.4],[69.19,22.42],[69.16,22.31],[69.23,22.26],[69.49,22.34],[69.5,22.44],[69.58,22.32],[69.73,22.47],[69.8,22.4],[`,
  `69.83,22.5],[69.87,22.45],[69.98,22.54],[70.16,22.55],[70.49,23.08],[70.35,22.93],[70.12,22.96],[70.15,23.03],[70.13,22.92],[69.8,22.85],[69.71,22.73],[69.63,22.8],[69.47,22.77],[69.19,22.84],[68.66,23.15],[68.59,23.23],[68.76,23.33],[68.65,23.3],[68.49,23.5],[68.5,23.65],[68.76,23.87],[68.53,23.76],[68.52,23.82],[68.66,23.92],[68.55,23.96],[68.75,23.96],[68.77,24.29],[68.89,24.2],[68.95,24.28],[69.0,24.23],[69.6,24.28],[69.72,24.18],[70.0,24.17],[70.12,24.29],[70.57,24.42],[70.57,24.25],[70.81,24.22],[71.13,24.4],[71.01,24.44],[71.0,24.54],[71.11,24.68],[71.3,24.61],[71.54,24.68],[71.8,24.67],[71.86,24.6],[71.88,24.68],[71.94,24.63],[72.05,24.71],[72.1,24.64]]]]}},{"type":"Feature","properties":{"n":"Haryana"},"geometry":{"type":"Polygon","coordinates":[[[76.84,30.88],[77.15,30.69],[77.11,30.57],[77.2,30.48],[77.45,30.47],[77.43,30.4],[77.51,30.45],[77.59,30.37],[77.41,30.11],[77.27,30.05],[77.12,29.77],[77.12,29.11],[77.22,28.9],[76.94,28.82],[76.93,28.64],[76.83,28.58],[76.88,28.51],[77.07,28.52],[77.17,28.41],[77.33,28.51],[77.47,28.41],[77.54,27.95],[77.23,27.79],[77.04,27.82],[77.08,27.74],[76.99,27.74],[76.97,27.66],[76.88,27.7],[76.96,28.14],[76.86,28.22],[76.54,27.97],[76.54,28.04],[76.45,28.05],[76.47,28.15],[76.29,28.18],[76.34,28.03],[76.18,28.06],[76.15,28.0],[76.22,27.84],[75.96,27.86],[75.92,27.93],[76.04,28.07],[75.94,28.09],[76.09,28.16],[75.92,28.37],[75.77,28.41],[75.56,28.61],[75.47,28.93],[75.51,29.01],[75.36,29.14],[75.4,29.26],[75.08,29.23],[74.84,29.4],[74.6,29.33],[74.53,29.45],[74.61,29.53],[74.61,29.75],[74.47,29.79],[74.55,29.87],[74.52,29.95],[74.65,29.9],[74.8,29.99],[74.99,29.86],[75.08,29.92],[75.09,29.81],[75.18,29.84],[75.23,29.75],[75.16,29.66],[75.22,29.55],[75.44,29.81],[75.57,29.74],[75.77,29.83],[76.04,29.75],[76.24,29.87],[76.17,29.93],[76.25,30.1],[76.2,30.16],[76.32,30.11],[76.41,30.2],[76.45,30.1],[76.6,30.08],[76.64,30.21],[76.55,30.26],[76.72,30.33],[76.76,30.44],[76.93,30.39],[76.76,30.89],[76.84,30.88]]]}},{"type":"Feat`,
  `ure","properties":{"n":"Himachal Pradesh"},"geometry":{"type":"Polygon","coordinates":[[[76.8,33.24],[76.92,33.03],[77.14,32.98],[77.33,32.82],[77.71,32.97],[77.98,32.59],[78.37,32.76],[78.39,32.62],[78.28,32.51],[78.44,32.51],[78.52,32.42],[78.44,32.25],[78.59,32.22],[78.6,32.12],[78.77,32.0],[78.69,31.79],[78.83,31.62],[78.71,31.52],[79.0,31.12],[78.87,31.11],[78.8,31.21],[78.47,31.2],[78.36,31.29],[77.89,31.15],[77.69,30.77],[77.81,30.53],[77.57,30.38],[77.12,30.55],[77.15,30.69],[76.9,30.9],[76.61,31.0],[76.63,31.22],[76.43,31.28],[76.36,31.44],[76.3,31.32],[76.17,31.31],[75.89,31.95],[75.58,32.08],[75.66,32.16],[75.62,32.23],[75.93,32.42],[75.85,32.51],[75.91,32.76],[75.79,32.89],[75.99,32.9],[76.39,33.19],[76.63,33.16],[76.8,33.24]]]}},{"type":"Feature","properties":{"n":"Jammu and Kashmir"},"geometry":{"type":"Polygon","coordinates":[[[77.9,35.43],[78.11,35.48],[77.99,35.35],[78.25,34.7],[78.57,34.61],[78.98,34.33],[78.96,34.22],[78.71,34.07],[78.78,33.77],[78.71,33.65],[79.07,33.23],[79.41,33.18],[79.35,32.98],[79.54,32.75],[79.55,32.61],[79.31,32.49],[79.2,32.51],[79.1,32.37],[78.98,32.34],[78.78,32.48],[78.75,32.7],[78.31,32.48],[78.37,32.76],[77.98,32.59],[77.71,32.97],[77.33,32.82],[77.14,32.98],[76.92,33.03],[76.78,33.26],[76.73,33.18],[76.39,33.19],[75.95,32.89],[75.81,32.93],[75.92,32.64],[75.5,32.28],[75.07,32.48],[74.7,32.48],[74.64,32.61],[74.7,32.84],[74.53,32.74],[74.32,32.92],[74.35,33.02],[74.01,33.2],[74.19,33.46],[73.96,33.72],[74.22,33.87],[74.26,33.97],[74.21,34.04],[73.88,34.05],[73.98,34.26],[73.9,34.36],[73.76,34.37],[73.95,34.57],[73.96,34.7],[74.14,34.69],[74.38,34.8],[75.75,34.52],[76.47,34.79],[76.68,34.76],[76.75,34.93],[77.0,34.94],[77.02,35.04],[77.16,35.05],[77.82,35.5],[77.9,35.43]]]}},{"type":"Feature","properties":{"n":"Jharkhand"},"geometry":{"type":"Polygon","coordinates":[[[87.6,25.31],[87.78,25.25],[87.78,25.09],[87.97,24.9],[87.82,24.77],[87.9,24.72],[87.91,24.59],[87.77,24.58],[87.81,24.41],[87.64,24.24],[87.69,24.15],[8`,
  `7.49,24.12],[87.46,23.98],[87.24,24.04],[87.29,23.9],[87.24,23.83],[86.79,23.83],[86.79,23.69],[86.44,23.63],[86.3,23.42],[86.05,23.58],[86.05,23.49],[85.86,23.45],[85.83,23.2],[85.91,23.13],[86.04,23.14],[86.21,22.99],[86.54,22.99],[86.43,22.92],[86.42,22.78],[86.62,22.67],[86.65,22.58],[86.76,22.57],[86.75,22.45],[86.89,22.25],[86.75,22.21],[86.5,22.34],[86.43,22.3],[86.04,22.56],[85.95,22.46],[86.03,22.19],[85.91,21.97],[85.76,21.99],[85.8,22.11],[85.68,22.05],[85.39,22.16],[85.23,22.0],[85.1,22.1],[84.98,22.08],[85.11,22.29],[85.06,22.48],[84.29,22.34],[84.0,22.52],[84.08,22.64],[84.22,22.67],[84.39,22.94],[84.19,23.02],[84.15,22.96],[84.03,23.14],[84.07,23.33],[83.97,23.38],[84.01,23.63],[83.94,23.56],[83.77,23.6],[83.7,23.82],[83.56,23.86],[83.51,24.03],[83.32,24.1],[83.45,24.36],[83.4,24.5],[83.87,24.53],[83.99,24.64],[84.11,24.48],[84.3,24.56],[84.29,24.45],[84.49,24.29],[84.52,24.38],[84.66,24.39],[84.8,24.53],[84.9,24.37],[85.08,24.44],[85.09,24.38],[85.28,24.53],[85.66,24.58],[85.74,24.82],[85.95,24.73],[86.05,24.78],[86.13,24.6],[86.32,24.58],[86.28,24.46],[86.45,24.37],[86.6,24.61],[86.78,24.62],[86.91,24.54],[86.93,24.64],[87.05,24.61],[87.18,25.06],[87.29,25.09],[87.32,25.22],[87.47,25.19],[87.49,25.31],[87.6,25.31]]]}},{"type":"Feature","properties":{"n":"Karnataka"},"geometry":{"type":"MultiPolygon","coordinates":[[[[74.6709747314456,13.199861526489371],[74.6709747314456,13.199584007263468],[74.67152404785162,13.199584007263468],[74.67152404785162,13.199305534362907]]],[[[74.72846984863298,13.282921791076888],[74.72846984863298,13.282640457153434],[74.72875213623053,13.282640457153434],[74.72875213623053,13.28208065032959]]],[[[74.70041656494158,13.284310340881632],[74.70041656494158,13.283459663391397],[74.70069122314459,13.283472061157227],[74.70069122314459,13.282917976379508]]],[[[74.72374725341803,13.289590835571289],[74.72374725341803,13.28931140899681],[74.72429656982439,13.28931140899681],[74.72429656982439,13.289031028747843]]],[[[74.690696`,
  `71630876,13.334030151367415],[74.69069671630876,13.333751678467024],[74.69097137451178,13.333751678467024],[74.69097137451178,13.33319091796892]]],[[[74.6890258789063,13.340971946716252],[74.6890258789063,13.339305877685604],[74.68930816650419,13.3393106460573],[74.68930816650419,13.338751792907942]]],[[[74.68264007568388,13.348472595214844],[74.68264007568388,13.34819507598877],[74.68291473388672,13.34819507598877],[74.68291473388672,13.347639083862475]]],[[[74.67152404785162,13.383193016052473],[74.67152404785162,13.382917404174975],[74.67180633544939,13.382917404174975],[74.67180633544939,13.382638931274585]]],[[[74.48291778564482,14.011249542236385],[74.48291778564482,14.010972023010481],[74.48319244384783,14.010972023010481],[74.48319244384783,14.010417938232422]]],[[[74.32624816894537,14.020694732666186],[74.32624816894537,14.020417213439885],[74.32682037353521,14.020421028137434],[74.32682037353521,14.01986026763933]]],[[[74.40319824218778,14.315401077270565],[74.40319824218778,14.315137863159237],[74.40402984619158,14.315140724182129],[74.40402984619158,14.314860343933333]]],[[[74.3651428222658,14.55263996124279],[74.3651428222658,14.552359580993652],[74.36597442626959,14.552362442016715],[74.36597442626959,14.552082061767749]]],[[[74.25375366210955,14.705973625183276],[74.25375366210955,14.705693244934082],[74.2543029785158,14.705693244934082],[74.2543029785158,14.705417633056584]]],[[[74.24069213867216,14.711250305175952],[74.24069213867216,14.71097183227539],[74.2409744262697,14.71097183227539],[74.2409744262697,14.709861755371207]]],[[[74.15541839599638,14.741810798645304],[74.15541839599638,14.741531372070426],[74.15598297119152,14.741531372070426],[74.15598297119152,14.741250038146973]]],[[[74.11125183105486,14.761541366577092],[74.11125183105486,14.761249542236612],[74.11152648925787,14.761249542236612],[74.11152648925787,14.759580612182901]]],[[[74.08791351318388,14.79597187042242],[74.08791351318388,14.795694351196346],[74.0887527465822,14.795694351`,
  `196346],[74.0887527465822,14.795415878295955]]],[[[74.0565261840822,14.817084312439135],[74.0565261840822,14.816805839538574],[74.05680847167997,14.816809654235897],[74.05680847167997,14.816530227661246]]],[[[74.0640258789063,14.82124996185297],[74.0640258789063,14.820969581604004],[74.06458282470709,14.820972442627067],[74.06458282470709,14.820693969726676]]],[[[74.05930328369169,14.821528434753532],[74.05930328369169,14.82124996185297],[74.06179809570341,14.82124996185297],[74.06179809570341,14.820700645446948]]],[[[74.09402465820341,14.838471412658635],[74.09402465820341,14.838195800781307],[74.09430694580078,14.838195800781307],[74.09430694580078,14.837638854980753]]],[[[74.09847259521501,14.845972061157227],[74.09847259521501,14.845693588256836],[74.09874725341803,14.845693588256836],[74.09874725341803,14.845417976379508]]],[[[74.09708404541044,14.87847232818632],[74.09708404541044,14.877916336059627],[74.09735870361328,14.877921104431323],[74.09735870361328,14.877079963684196]]],[[[77.34,18.44],[77.41,18.39],[77.36,18.31],[77.6,18.28],[77.55,18.05],[77.65,17.97],[77.44,17.58],[77.69,17.5],[77.51,17.43],[77.38,17.22],[77.5,17.01],[77.42,16.66],[77.46,16.58],[77.24,16.47],[77.59,16.29],[77.49,16.25],[77.51,15.92],[77.18,15.95],[77.02,15.83],[77.12,15.66],[77.03,15.63],[76.97,15.49],[77.16,15.26],[77.16,15.16],[77.08,15.0],[76.77,15.07],[76.76,14.97],[76.87,14.94],[76.76,14.6],[76.87,14.47],[76.97,14.48],[76.88,14.39],[76.94,14.24],[77.11,14.21],[77.15,14.34],[77.28,14.33],[77.38,14.19],[77.39,14.32],[77.5,14.26],[77.5,14.15],[77.35,14.12],[77.4,14.1],[77.33,14.02],[77.43,13.97],[77.4,13.88],[77.31,14.02],[77.15,13.99],[77.02,14.05],[77.02,14.17],[76.89,14.16],[77.04,13.93],[76.99,13.74],[77.17,13.75],[77.18,13.92],[77.18,13.86],[77.42,13.84],[77.48,13.68],[77.65,13.78],[77.71,13.73],[77.82,13.93],[77.98,13.95],[77.94,13.82],[78.04,13.89],[78.11,13.84],[78.08,13.64],[78.16,13.65],[78.18,13.56],[78.39,13.58],[78.37,13.32],[78.58,13.26],[78.42,12.97],[78.45,12.85],`,
  `[78.35,12.93],[78.22,12.75],[77.83,12.86],[77.73,12.66],[77.59,12.66],[77.62,12.41],[77.47,12.2],[77.73,12.17],[77.77,12.11],[77.66,11.94],[77.48,11.93],[77.42,11.75],[77.24,11.8],[77.11,11.71],[77.0,11.8],[76.9,11.78],[76.84,11.57],[76.56,11.61],[76.5,11.7],[76.41,11.66],[76.41,11.75],[76.11,11.85],[76.11,11.97],[75.87,11.95],[75.8,12.07],[75.66,12.09],[75.42,12.29],[75.37,12.41],[75.41,12.5],[75.34,12.46],[75.27,12.54],[75.33,12.59],[75.05,12.66],[74.99,12.79],[74.87,12.75],[74.63,13.85],[74.5,14.02],[74.39,14.55],[74.31,14.52],[74.25,14.74],[74.09,14.8],[74.1,14.9],[74.27,14.97],[74.32,15.18],[74.26,15.26],[74.34,15.29],[74.26,15.65],[74.1,15.67],[74.23,15.79],[74.36,15.77],[74.47,16.04],[74.37,16.05],[74.5,16.1],[74.5,16.23],[74.33,16.27],[74.37,16.39],[74.28,16.54],[74.39,16.53],[74.48,16.66],[74.57,16.55],[74.69,16.6],[74.7,16.72],[74.92,16.77],[74.94,16.94],[75.09,16.95],[75.22,16.84],[75.29,16.95],[75.67,16.96],[75.66,17.26],[75.58,17.38],[75.64,17.48],[75.8,17.37],[75.89,17.42],[75.93,17.32],[76.12,17.37],[76.18,17.3],[76.24,17.37],[76.38,17.31],[76.33,17.59],[76.49,17.66],[76.52,17.76],[76.69,17.68],[76.79,17.83],[76.74,17.9],[76.92,17.92],[76.95,18.18],[77.11,18.15],[77.24,18.41],[77.34,18.44]]]]}},{"type":"Feature","properties":{"n":"Kerala"},"geometry":{"type":"MultiPolygon","coordinates":[[[[76.46736145019526,9.540970802307243],[76.46736145019526,9.540693283081339],[76.46847534179716,9.540693283081339],[76.46847534179716,9.54041767120384]]],[[[76.404296875,9.54152965545677],[76.404296875,9.53986072540306],[76.40458679199247,9.53986072540306],[76.40458679199247,9.537082672119311]]],[[[76.43458557128923,9.551527976989973],[76.43458557128923,9.551250457763672],[76.43486022949224,9.551250457763672],[76.43486022949224,9.548193931579533]]],[[[76.43680572509794,9.551527976989973],[76.43680572509794,9.551250457763672],[76.43736267089855,9.551250457763672],[76.43736267089855,9.550971984863509]]],[[[76.41430664062528,9.56319522857666],[76.41430664062528,9.562916`,
  `755676497],[76.4145812988283,9.562919616699162],[76.4145812988283,9.562360763549805]]],[[[76.38541412353516,9.620693206787337],[76.38541412353516,9.620417594909838],[76.38597106933611,9.620420455932901],[76.38597106933611,9.62014198303234]]],[[[76.38124847412115,9.714582443237532],[76.38069152832037,9.71457958221447],[76.38069152832037,9.71514129638689],[76.38096618652338,9.71514129638689]]],[[[76.37152862548834,9.758472442627067],[76.37152862548834,9.757916450500772],[76.37180328369135,9.757920265197754],[76.37180328369135,9.756260871887378]]],[[[76.32402801513678,9.825695037841797],[76.32402801513678,9.825416564941406],[76.32457733154303,9.825421333313045],[76.32457733154303,9.824860572814941]]],[[[76.37236022949247,9.825695037841797],[76.37236022949247,9.825416564941406],[76.37291717529325,9.825421333313045],[76.37291717529325,9.825140953063908]]],[[[76.3684692382813,9.826811790466593],[76.3684692382813,9.826531410217228],[76.36958312988281,9.826531410217228],[76.36958312988281,9.826251029968262]]],[[[76.378471374512,9.839584350586165],[76.378471374512,9.8390283584597],[76.3787460327149,9.839030265808105],[76.3787460327149,9.838472366333065]]],[[[76.37763977050787,9.84152984619169],[76.37763977050787,9.840690612792969],[76.37735748291033,9.840694427490348],[76.37735748291033,9.840417861938533]]],[[[76.28930664062506,9.847361564636174],[76.28930664062506,9.847082138061694],[76.28986358642584,9.847082138061694],[76.28986358642584,9.84680557250988]]],[[[76.34958648681646,9.874582290649528],[76.34958648681646,9.87402820587181],[76.34986114501982,9.874031066894531],[76.34986114501982,9.873191833496207]]],[[[76.30847167968778,9.921529769897688],[76.30847167968778,9.92125034332281],[76.30874633789068,9.92125034332281],[76.30874633789068,9.920694351196516]]],[[[76.26069641113287,9.970696449279899],[76.26069641113287,9.970417976379508],[76.26207733154308,9.970421791076888],[76.26207733154308,9.970140457153434]]],[[[76.27236175537115,9.97291469574003],[76.27236175537115,9.`,
  `972084045410156],[76.27263641357422,9.972084045410156],[76.27263641357422,9.971805572509766]]],[[[76.24430847167974,9.980972290039176],[76.24430847167974,9.978471755981502],[76.24402618408203,9.978471755981502],[76.24402618408203,9.978194236755598]]],[[[76.26819610595732,10.002920150756836],[76.26819610595732,10.00263977050804],[76.26847076416033,10.00263977050804],[76.26847076416033,10.002081871032772]]],[[[76.2418060302735,10.014310836792106],[76.2418060302735,10.014031410217228],[76.24208068847685,10.014031410217228],[76.24208068847685,10.013751029968262]]],[[[76.252914428711,10.017083168029728],[76.252914428711,10.013751029968262],[76.25347137451178,10.013751029968262],[76.25347137451178,10.013469696045206]]],[[[76.26180267334001,10.029862403869572],[76.26180267334001,10.029306411743107],[76.261528015137,10.029310226440657],[76.261528015137,10.02902984619152]]],[[[76.26597595214861,10.030694007873763],[76.26597595214861,10.030139923095874],[76.26569366455084,10.030139923095874],[76.26569366455084,10.02791786193876]]],[[[76.23986053466814,10.102370262146223],[76.23986053466814,10.102081298828239],[76.24013519287115,10.102083206176985],[76.24013519287115,10.101804733276424]]],[[[76.05208587646513,10.535420417785815],[76.05208587646513,10.534581184387491],[76.05180358886736,10.534583091735897],[76.05180358886736,10.534027099609602]]],[[[76.05097198486357,10.539030075073356],[76.05097198486357,10.538741111755371],[76.0512466430664,10.538749694824219],[76.0512466430664,10.537918090820426]]],[[[75.83819580078125,11.134310722351074],[75.83819580078125,11.134030342102278],[75.83847045898466,11.134030342102278],[75.83847045898466,11.133749961853141]]],[[[75.81124877929688,11.16180610656761],[75.81124877929688,11.161527633667049],[75.81153106689459,11.161529541015625],[75.81153106689459,11.160689353943042]]],[[[75.3662490844726,11.942084312439079],[75.3662490844726,11.941805839538688],[75.36596679687506,11.941810607910156],[75.36596679687506,11.940691947936955]]],[[[75.36`,
  `791992187528,11.943471908569336],[75.36791992187528,11.942359924316406],[75.36818695068376,11.942359924316406],[75.36818695068376,11.941810607910156]]],[[[75.30069732666033,11.963472366333065],[75.30069732666033,11.963195800781477],[75.30124664306658,11.963195800781477],[75.30124664306658,11.962915420532283]]],[[[75.29652404785162,11.968471527099837],[75.29652404785162,11.968194007873592],[75.2968063354495,11.968194007873592],[75.2968063354495,11.967915534973372]]],[[[75.28541564941423,11.98708343505865],[75.28541564941423,11.98680496215826],[75.28597259521501,11.986809730529956],[75.28597259521501,11.986540794372672]]],[[[75.29792022705107,12.01736164093046],[75.29792022705107,12.016248703003043],[75.2976379394533,12.016248703003043],[75.2976379394533,12.015969276428166]]],[[[75.2976379394533,12.023750305175895],[75.2976379394533,12.023469924926758],[75.29819488525408,12.023471832275504],[75.29819488525408,12.02319431304943]]],[[[75.15763854980486,12.109311103820914],[75.15763854980486,12.109028816223145],[75.15791320800793,12.109030723571948],[75.15791320800793,12.108750343322981]]],[[[75.16346740722685,12.115419387817383],[75.16346740722685,12.115140914916992],[75.16374969482439,12.115140914916992],[75.16374969482439,12.114860534668196]]],[[[75.19403076171875,12.116250991821346],[75.19403076171875,12.11597061157238],[75.19430541992193,12.115973472595442],[75.19430541992193,12.11541652679449]]],[[[75.1540298461914,12.142641067504826],[75.1540298461914,12.14208126068138],[75.15430450439482,12.142083168029785],[75.15430450439482,12.141529083252067]]],[[[75.13541412353544,12.185972213745174],[75.13541412353544,12.185693740844783],[75.135971069336,12.185693740844783],[75.135971069336,12.185137748718319]]],[[[75.13181304931669,12.19153118133545],[75.13181304931669,12.191250801086653],[75.13208007812517,12.191250801086653],[75.13208007812517,12.190960884094352]]],[[[75.13014221191423,12.198195457458553],[75.13014221191423,12.197916984558162],[75.13069152832026,12.197921`,
  `75292963],[75.13069152832026,12.197641372680664]]],[[[75.12652587890642,12.205142021179427],[75.12652587890642,12.20486164093029],[75.12680816650396,12.20486164093029],[75.12680816650396,12.204031944274902]]],[[[75.0,12.79],[75.05,12.66],[75.33,12.59],[75.27,12.55],[75.34,12.46],[75.41,12.5],[75.37,12.41],[75.42,12.29],[75.58,12.15],[75.8,12.07],[75.88,11.94],[76.11,11.97],[76.12,11.84],[76.41,11.75],[76.43,11.63],[76.23,11.56],[76.24,11.46],[76.54,11.35],[76.45,11.18],[76.73,11.21],[76.69,11.14],[76.79,11.04],[76.65,10.92],[76.9,10.77],[76.87,10.63],[76.8,10.63],[76.82,10.3],[76.97,10.21],[77.22,10.34],[77.28,10.21],[77.19,10.09],[77.26,9.96],[77.15,9.61],[77.34,9.6],[77.4,9.5],[77.13,9.01],[77.24,8.86],[77.16,8.74],[77.27,8.54],[77.19,8.49],[77.16,8.31],[76.98,8.38],[76.55,8.9],[76.34,9.42],[76.24,9.97],[76.35,9.71],[76.32,9.87],[76.37,9.82],[76.36,9.53],[76.48,9.51],[76.38,9.86],[76.21,10.15],[76.22,9.98],[76.07,10.54],[75.91,10.79],[75.86,11.14],[75.62,11.48],[75.5,11.8],[75.45,11.77],[75.3,11.94],[75.37,11.96],[75.27,12.01],[75.4,12.14],[75.22,12.1],[75.2,12.01],[74.87,12.75],[75.0,12.79]]]]}},{"type":"Feature","properties":{"n":"Lakshadweep"},"geometry":{"type":"MultiPolygon","coordinates":[[[[73.0101394653322,8.28042030334484],[73.0101394653322,8.280139923095874],[73.01040649414068,8.280139923095874],[73.01040649414068,8.27985954284668]]],[[[73.08097076416021,8.327642440796012],[73.08097076416021,8.327080726623763],[73.0806961059572,8.327082633972168],[73.0806961059572,8.326249122619629]]],[[[72.29013824462908,10.049583435058821],[72.29013824462908,10.049027442932356],[72.28985595703153,10.049030303955078],[72.28985595703153,10.048471450805721]]],[[[73.63346862792986,10.070419311523551],[73.63346862792986,10.07014083862316],[73.63375091552746,10.07014083862316],[73.63375091552746,10.0687513351441]]],[[[73.62902832031278,10.075141906738509],[73.62902832031278,10.074860572814885],[73.62930297851568,10.074860572814885],[73.62930297851568,10.07458305358898]]],[[[`,
  `73.65152740478544,10.104310035705566],[73.65152740478544,10.10263919830328],[73.65180206298828,10.10263919830328],[73.65180206298828,10.101531982421989]]],[[[72.32791900634771,10.136529922485352],[72.32791900634771,10.136249542236555],[72.32819366455107,10.136249542236555],[72.32818603515653,10.135690689087198]]],[[[73.6609725952149,10.155973434448299],[73.6609725952149,10.155693054199332],[73.66124725341825,10.155693054199332],[73.66124725341825,10.155138969421444]]],[[[72.64208221435553,10.577361106872672],[72.64208221435553,10.577081680297965],[72.64514160156256,10.577081680297965],[72.64514160156256,10.576804161071891]]],[[[72.16874694824247,10.814862251281738],[72.16874694824247,10.813471794128418],[72.16902923583984,10.813471794128418],[72.16902923583984,10.813194274902514]]],[[[72.1726379394533,10.81986141204834],[72.1726379394533,10.81902885437023],[72.17236328125028,10.81902885437023],[72.17236328125028,10.817920684814453]]],[[[73.67846679687517,10.82153129577631],[73.67846679687517,10.82069015502941],[73.67736053466797,10.820694923400879],[73.67736053466797,10.820417404174805]]],[[[72.1726379394533,10.81986141204834],[72.1726379394533,10.82014083862299],[72.17292022705107,10.820138931274414],[72.17292022705107,10.82097339630127]]],[[[72.29125213623064,10.945972442627237],[72.29125213623064,10.945139884948787],[72.29041290283232,10.94515132904047],[72.29041290283232,10.94486045837408]]],[[[72.32653045654314,10.95319461822504],[72.32653045654314,10.952360153198185],[72.32624816894537,10.952360153198185],[72.32624816894537,10.951804161071891]]],[[[72.33374786376982,10.95847320556669],[72.33374786376982,10.95819473266613],[72.3343048095706,10.95819473266613],[72.3343048095706,10.955972671509016]]],[[[72.73153686523443,11.136249542236328],[72.73153686523443,11.135972023010254],[72.73236083984403,11.135972023010254],[72.73236083984403,11.135693550109863]]],[[[72.10569763183611,11.21291637420677],[72.10569763183611,11.212639808654785],[72.10597229003935,11.212639`,
  `808654785],[72.10597229003935,11.212081909179915]]],[[[72.10291290283214,11.21514034271263],[72.10291290283214,11.214859962463493],[72.10320281982439,11.214859962463493],[72.10319519042986,11.214584350586165]]],[[[72.79013824462919,11.259860992431868],[72.79013824462919,11.259583473205566],[72.7904129028322,11.259583473205566],[72.7904129028322,11.259026527405013]]],[[[73.00096893310564,11.488194465637434],[73.00096893310564,11.487915992737044],[73.0015258789062,11.487920761108512],[73.0015258789062,11.486810684204329]]],[[[72.99986267089861,11.497921943664778],[72.99986267089861,11.497361183166447],[73.00013732910185,11.497361183166447],[73.00013732910185,11.497640609741325]]],[[[72.18624877929693,11.601260185241927],[72.18624877929693,11.600970268249625],[72.1865310668947,11.600973129272688],[72.1865310668947,11.600417137146223]]],[[[72.71402740478527,11.706251144409407],[72.71402740478527,11.705967903137207],[72.71430206298845,11.705972671509016],[72.71430206298845,11.705415725708065]]]]}},{"type":"Feature","properties":{"n":"Madhya Pradesh"},"geometry":{"type":"Polygon","coordinates":[[[78.36,26.87],[78.57,26.76],[78.72,26.8],[78.99,26.68],[78.98,26.57],[79.13,26.34],[78.94,26.14],[79.0,26.08],[78.86,25.8],[78.75,25.75],[78.81,25.62],[78.43,25.56],[78.3,25.37],[78.44,25.13],[78.33,25.09],[78.33,25.0],[78.16,24.86],[78.27,24.67],[78.22,24.52],[78.38,24.27],[78.51,24.39],[78.79,24.18],[78.97,24.35],[78.88,24.64],[78.75,24.6],[78.78,24.81],[78.62,24.96],[78.57,25.26],[78.43,25.29],[78.65,25.44],[78.76,25.36],[78.81,25.43],[78.73,25.5],[78.83,25.43],[78.89,25.56],[78.98,25.38],[78.78,25.3],[78.84,25.23],[78.88,25.34],[78.96,25.35],[78.88,25.16],[79.0,25.2],[79.0,25.28],[79.02,25.14],[79.08,25.19],[79.12,25.11],[79.28,25.12],[79.27,25.25],[79.35,25.21],[79.26,25.28],[79.3,25.34],[79.35,25.27],[79.49,25.27],[79.4,25.11],[79.49,25.08],[79.57,25.18],[79.85,25.1],[79.85,25.24],[80.26,25.43],[80.42,25.17],[80.28,25.06],[80.31,25.0],[80.49,25.05],[80.48,25.1],[80.61,25.07]`,
  `,[80.59,25.16],[80.67,25.05],[80.78,25.06],[80.7,25.14],[80.83,25.11],[80.88,25.2],[80.8,24.94],[81.08,24.95],[81.13,24.89],[81.21,24.93],[81.27,25.17],[81.48,25.07],[81.57,25.2],[81.6,25.06],[81.9,25.01],[81.96,24.83],[82.2,24.82],[82.17,24.74],[82.24,24.78],[82.29,24.61],[82.41,24.6],[82.42,24.71],[82.53,24.65],[82.66,24.7],[82.8,24.6],[82.71,24.56],[82.76,24.29],[82.66,24.13],[82.81,23.96],[82.63,23.84],[82.5,23.79],[81.92,23.87],[81.81,23.81],[81.66,23.93],[81.6,23.89],[81.69,23.72],[81.57,23.59],[81.61,23.51],[81.92,23.53],[81.98,23.41],[82.19,23.33],[82.15,23.14],[81.94,23.08],[81.94,22.96],[81.77,22.87],[81.76,22.66],[81.62,22.54],[81.4,22.44],[81.32,22.52],[81.11,22.44],[81.0,22.07],[80.91,22.11],[80.81,21.75],[80.72,21.71],[80.66,21.34],[80.4,21.38],[80.26,21.62],[79.92,21.52],[79.73,21.6],[79.54,21.54],[79.49,21.67],[79.23,21.72],[79.22,21.65],[78.91,21.59],[78.93,21.49],[78.43,21.5],[78.38,21.62],[77.94,21.39],[77.58,21.36],[77.49,21.38],[77.42,21.53],[77.61,21.54],[77.54,21.7],[77.48,21.77],[77.29,21.76],[76.8,21.6],[76.78,21.47],[76.62,21.34],[76.62,21.19],[76.49,21.2],[76.38,21.08],[76.17,21.08],[76.1,21.37],[75.22,21.41],[74.9,21.63],[74.56,21.68],[74.45,22.03],[74.29,21.94],[74.15,21.95],[74.1,22.02],[74.18,22.09],[74.07,22.36],[74.19,22.32],[74.29,22.39],[74.19,22.48],[74.12,22.42],[74.04,22.54],[74.15,22.52],[74.27,22.64],[74.38,22.64],[74.48,22.86],[74.32,23.06],[74.75,23.21],[74.52,23.33],[74.61,23.46],[74.94,23.63],[74.91,23.87],[74.99,24.03],[74.89,24.26],[74.75,24.28],[74.86,24.47],[74.71,24.51],[74.82,24.67],[74.8,24.8],[74.89,24.66],[75.02,24.77],[74.85,24.79],[74.83,24.97],[75.04,24.86],[75.16,25.05],[75.35,25.04],[75.26,24.89],[75.42,24.86],[75.31,24.81],[75.21,24.91],[75.22,24.72],[75.84,24.73],[75.91,24.46],[75.79,24.48],[75.73,24.41],[75.83,24.25],[75.74,24.14],[75.83,24.08],[75.7,23.97],[75.51,24.05],[75.46,23.92],[75.58,23.8],[75.68,23.76],[75.7,23.9],[75.78,23.85],[75.98,23.93],[75.96,24.03],[76.13,24.1],[76.19,24.33],[76.22,24.22],[`,
  `76.47,24.23],[76.53,24.16],[76.69,24.29],[76.7,24.17],[76.9,24.13],[76.94,24.21],[76.81,24.53],[76.91,24.54],[76.97,24.46],[77.06,24.57],[77.03,24.71],[76.8,24.82],[76.95,24.87],[76.85,25.01],[77.4,25.11],[77.36,25.41],[77.28,25.42],[77.21,25.31],[76.77,25.31],[76.56,25.44],[76.48,25.72],[76.59,25.87],[76.75,25.91],[77.12,26.24],[77.81,26.55],[77.89,26.66],[78.09,26.68],[78.11,26.8],[78.36,26.87]]]}},{"type":"Feature","properties":{"n":"Maharashtra"},"geometry":{"type":"MultiPolygon","coordinates":[[[[73.45597076416021,15.889862060547102],[73.45597076416021,15.889583587646541],[73.45625305175798,15.889583587646541],[73.45625305175798,15.889306068420638]]],[[[73.46263885498053,15.890419960021973],[73.46263885498053,15.890151023864917],[73.46347045898466,15.890151023864917],[73.46347045898466,15.88985919952404]]],[[[73.4662475585938,15.895972251892147],[73.4662475585938,15.895693778991756],[73.46680450439459,15.895693778991756],[73.46680450439459,15.895416259765852]]],[[[73.46013641357428,16.04569435119629],[73.46013641357428,16.0454158782959],[73.46041870117216,16.04541969299345],[73.46041870117216,16.045141220092887]]],[[[73.44319152832037,16.10263824462885],[73.44319152832037,16.10235977172846],[73.44347381591814,16.102361679077262],[73.44347381591814,16.10208320617687]]],[[[73.08429718017572,17.818750381469897],[73.08429718017572,17.818471908569336],[73.08458709716803,17.818471908569336],[73.08458709716803,17.81819534301752]]],[[[73.03819274902361,18.052083969116154],[73.03819274902361,18.051525115966797],[73.03848266601591,18.051530838012923],[73.03848266601591,18.050979614257926]]],[[[72.96597290039068,18.3012504577639],[72.96597290039068,18.300140380859375],[72.96652984619146,18.300140380859375],[72.96652984619146,18.299861907958984]]],[[[73.07903289794928,18.310419082641715],[73.07903289794928,18.310140609741325],[73.07930755615263,18.310140609741325],[73.07930755615263,18.30987167358427]]],[[[73.08208465576178,18.32208251953125],[73.08208465576178,18.32125091`,
  `5527457],[73.08235931396513,18.321250915527457],[73.08235931396513,18.32097053527832]]],[[[72.86486053466803,18.635694503784464],[72.86486053466803,18.635139465332088],[72.86514282226557,18.635139465332088],[72.86513519287138,18.63458061218273]]],[[[72.81263732910168,18.706529617309627],[72.81263732910168,18.706251144409237],[72.81291961669939,18.706251144409237],[72.81291961669939,18.7059707641601]]],[[[72.84263610839838,18.708471298217773],[72.84263610839838,18.708194732666186],[72.84291839599615,18.708194732666186],[72.84291839599615,18.70736122131342]]],[[[72.90152740478544,18.964311599731445],[72.90152740478544,18.964029312133846],[72.90207672119146,18.964029312133846],[72.90207672119146,18.963750839233683]]],[[[72.93902587890625,18.972360610961914],[72.93902587890625,18.972080230712947],[72.9395828247072,18.972085952758903],[72.9395828247072,18.971527099609375]]],[[[73.02597045898455,18.999860763549748],[73.02597045898455,18.99958038330078],[73.02708435058588,18.99958419799816],[73.02708435058588,18.99930572509777]]],[[[72.78180694580078,19.13541984558117],[72.78180694580078,19.135139465331974],[72.78263092041021,19.135139465331974],[72.78263092041021,19.13486099243164]]],[[[72.73124694824213,19.46847152709961],[72.73124694824213,19.46819686889677],[72.73153686523443,19.46820068359375],[72.73153686523443,19.467920303344954]]],[[[74.44,22.03],[74.59,21.66],[74.9,21.63],[75.3,21.39],[76.1,21.37],[76.14,21.13],[76.28,21.08],[76.62,21.19],[76.62,21.34],[76.78,21.47],[76.8,21.6],[77.29,21.76],[77.48,21.77],[77.54,21.7],[77.61,21.54],[77.42,21.53],[77.49,21.38],[77.58,21.36],[77.94,21.39],[78.38,21.62],[78.43,21.5],[78.93,21.49],[78.91,21.59],[79.22,21.65],[79.23,21.72],[79.49,21.67],[79.54,21.54],[79.73,21.6],[79.92,21.52],[80.26,21.62],[80.4,21.38],[80.67,21.31],[80.43,21.1],[80.58,20.68],[80.48,20.62],[80.62,20.6],[80.62,20.33],[80.38,20.24],[80.39,20.14],[80.55,20.07],[80.52,19.93],[80.41,19.93],[80.5,19.87],[80.39,19.79],[80.54,19.82],[80.66,19.61],[80.89,19.47`,
  `],[80.79,19.43],[80.85,19.36],[80.75,19.29],[80.61,19.31],[80.57,19.4],[80.48,19.34],[80.27,18.99],[80.35,18.81],[80.11,18.68],[79.89,18.83],[79.93,19.02],[79.86,19.1],[79.94,19.17],[79.97,19.4],[79.79,19.59],[79.47,19.5],[79.24,19.61],[79.18,19.46],[78.95,19.55],[78.97,19.65],[78.86,19.66],[78.85,19.76],[78.49,19.79],[78.31,19.91],[78.37,19.78],[78.27,19.66],[78.31,19.46],[78.18,19.41],[78.17,19.24],[77.95,19.34],[77.86,19.3],[77.85,19.09],[77.76,19.03],[77.94,18.82],[77.73,18.68],[77.74,18.55],[77.6,18.55],[77.53,18.43],[77.57,18.31],[77.36,18.31],[77.41,18.39],[77.32,18.45],[77.11,18.15],[76.95,18.18],[76.92,17.92],[76.74,17.9],[76.79,17.83],[76.69,17.68],[76.52,17.76],[76.49,17.66],[76.33,17.59],[76.38,17.31],[76.24,17.37],[76.18,17.3],[76.12,17.37],[75.93,17.32],[75.89,17.42],[75.8,17.37],[75.64,17.48],[75.58,17.38],[75.66,17.26],[75.67,16.96],[75.29,16.95],[75.22,16.84],[75.09,16.95],[74.94,16.94],[74.92,16.77],[74.7,16.72],[74.69,16.6],[74.57,16.55],[74.48,16.66],[74.39,16.53],[74.27,16.54],[74.37,16.39],[74.33,16.27],[74.51,16.2],[74.49,16.09],[74.37,16.05],[74.47,16.04],[74.36,15.77],[74.23,15.79],[74.03,15.6],[73.87,15.8],[73.68,15.73],[73.45,16.06],[73.41,16.4],[73.32,16.51],[73.39,16.55],[73.32,16.6],[73.25,17.03],[73.32,17.04],[73.19,17.3],[73.24,17.31],[73.17,17.41],[73.13,17.83],[72.93,18.22],[72.96,18.28],[73.09,18.15],[73.09,18.33],[73.03,18.26],[72.91,18.35],[72.86,18.7],[72.87,18.8],[72.98,18.81],[72.91,18.9],[73.03,19.0],[72.96,19.06],[72.81,18.89],[72.83,19.18],[72.78,19.17],[72.84,19.27],[72.78,19.19],[72.79,19.53],[72.72,19.54],[72.65,19.85],[72.69,19.96],[72.75,19.93],[72.74,20.14],[72.87,20.23],[73.18,20.05],[73.31,20.21],[73.43,20.2],[73.39,20.39],[73.5,20.54],[73.4,20.65],[73.46,20.71],[73.67,20.56],[73.95,20.74],[73.91,20.98],[73.59,21.17],[73.82,21.17],[73.95,21.4],[74.34,21.54],[73.86,21.5],[73.79,21.63],[73.9,21.7],[73.81,21.82],[74.44,22.03]]]]}},{"type":"Feature","properties":{"n":"Manipur"},"geometry":{"type":"Polygon","coordinates"`,
  `:[[[94.58,25.65],[94.56,25.51],[94.68,25.46],[94.59,25.22],[94.75,25.14],[94.74,25.03],[94.33,24.34],[94.16,23.85],[93.82,23.93],[93.76,24.01],[93.51,23.95],[93.35,24.11],[93.26,24.02],[93.25,24.09],[93.1,24.05],[92.98,24.11],[93.11,24.81],[93.2,24.81],[93.4,25.26],[93.47,25.31],[93.61,25.2],[93.84,25.56],[94.01,25.6],[94.31,25.49],[94.58,25.65]]]}},{"type":"Feature","properties":{"n":"Meghalaya"},"geometry":{"type":"Polygon","coordinates":[[[91.85,26.1],[91.92,26.0],[92.3,26.08],[92.16,25.94],[92.23,25.91],[92.16,25.67],[92.39,25.75],[92.57,25.56],[92.65,25.59],[92.57,25.47],[92.78,25.33],[92.8,25.22],[92.52,25.14],[92.43,25.03],[92.07,25.19],[91.64,25.12],[91.27,25.2],[90.45,25.14],[89.83,25.3],[89.87,25.54],[90.02,25.61],[89.9,25.74],[90.12,25.96],[90.48,26.02],[90.51,25.9],[90.58,25.96],[90.62,25.9],[90.94,25.95],[91.03,25.89],[91.0,25.82],[91.2,25.86],[91.22,25.72],[91.33,25.84],[91.53,25.87],[91.47,25.87],[91.58,26.03],[91.67,25.91],[91.73,26.06],[91.85,26.1]]]}},{"type":"Feature","properties":{"n":"Mizoram"},"geometry":{"type":"Polygon","coordinates":[[[92.8,24.42],[93.02,24.39],[92.98,24.11],[93.34,24.05],[93.44,23.68],[93.39,23.14],[93.3,23.01],[93.13,23.05],[93.17,22.92],[93.09,22.71],[93.21,22.26],[93.15,22.18],[93.05,22.2],[93.01,21.98],[92.96,22.03],[92.91,21.95],[92.72,22.15],[92.61,21.98],[92.53,22.68],[92.38,22.93],[92.41,23.25],[92.26,23.81],[92.33,23.91],[92.3,24.25],[92.42,24.25],[92.47,24.13],[92.77,24.52],[92.8,24.42]]]}},{"type":"Feature","properties":{"n":"Nagaland"},"geometry":{"type":"Polygon","coordinates":[[[95.21,26.94],[95.24,26.69],[95.07,26.46],[95.14,26.39],[95.12,26.11],[95.19,26.08],[95.02,25.91],[95.05,25.76],[94.9,25.57],[94.63,25.47],[94.56,25.51],[94.57,25.7],[94.31,25.49],[94.01,25.6],[93.84,25.56],[93.61,25.21],[93.51,25.24],[93.46,25.43],[93.33,25.55],[93.77,25.97],[93.8,25.81],[93.98,25.92],[94.0,26.17],[94.28,26.56],[94.32,26.46],[94.46,26.67],[94.76,26.77],[94.92,26.95],[95.02,26.93],[95.2,27.04],[95.21,26.94]]]}},{"type":`,
  `"Feature","properties":{"n":"Orissa"},"geometry":{"type":"MultiPolygon","coordinates":[[[[84.76985931396479,19.105972290039233],[84.76985931396479,19.104860305786076],[84.76957702636724,19.104860305786076],[84.76957702636724,19.104310989379883]]],[[[84.75653076171892,19.110971450805835],[84.75653076171892,19.11041641235363],[84.75680541992193,19.11041641235363],[84.75680541992193,19.10986137390165]]],[[[84.78319549560575,19.110971450805835],[84.78319549560575,19.11069488525402],[84.7834701538086,19.11069488525402],[84.7834701538086,19.110139846802042]]],[[[86.24055480957037,19.90944671630865],[86.24028015136736,19.909164428710938],[86.23990631103533,19.909164428710938],[86.23972320556658,19.909164428710938]]],[[[86.3724975585938,19.954444885254134],[86.37166595458984,19.953611373901595],[86.37150573730486,19.953758239746037],[86.37093353271501,19.953893661499137]]],[[[86.38694763183611,19.96277618408203],[86.38694763183611,19.96223068237316],[86.38582611084001,19.96111106872587],[86.38555908203153,19.96111106872587]]],[[[86.3924865722658,19.966108322143498],[86.39221954345732,19.965829849243107],[86.39194488525396,19.965833663940657],[86.39104461669928,19.965511322021655]]],[[[86.36860656738276,19.973890304565714],[86.36888885498053,19.97360992431635],[86.37046051025419,19.973611831665153],[86.37232971191412,19.97351837158226]]],[[[86.3211059570312,19.988059997558707],[86.32055664062517,19.988059997558707],[86.31999969482439,19.988611221313704],[86.31999969482439,19.989164352417106]]],[[[86.32138824462896,19.998889923095874],[86.32138824462896,19.99777984619169],[86.32166290283232,19.997499465942326],[86.32166290283232,19.996669769287337]]],[[[86.33557128906278,19.990829467773438],[86.33556365966825,19.9898166656497],[86.33557128906278,19.98954963684082],[86.33528137207048,19.988889694214095]]],[[[86.31042480468744,20.016246795654467],[86.31055450439459,20.016111373901538],[86.31138610839838,20.016111373901538],[86.3119430541995,20.015554428100586]]],[[[86.253051757`,
  `81267,20.025279998779524],[86.25332641601568,20.024999618530558],[86.25444793701178,20.024999618530558],[86.25472259521513,20.024721145630167]]],[[[86.4108505249024,20.01832962036127],[86.41027832031256,20.01777648925787],[86.40999603271479,20.01778030395525],[86.40972137451178,20.017499923706282]]],[[[86.27249908447283,20.024444580078352],[86.27194213867205,20.023889541626204],[86.27166748046903,20.023889541626204],[86.26972198486334,20.021938323974723]]],[[[86.3202743530274,20.029443740844954],[86.32055664062517,20.029165267944563],[86.32098388671875,20.029172897338924],[86.321304321289,20.029136657714844]]],[[[86.3150024414062,20.031669616699446],[86.31555175781278,20.03111076355009],[86.3158264160158,20.03111076355009],[86.31610870361357,20.030830383300724]]],[[[86.26583099365251,20.033611297607592],[86.26611328125006,20.03333282470703],[86.2663879394533,20.03333282470703],[86.26667022705084,20.033056259155217]]],[[[86.30999755859403,20.040832519531307],[86.31027984619158,20.040554046631087],[86.31083679199236,20.040571212768555],[86.31111145019537,20.040279388427905]]],[[[86.30055236816423,20.042499542236612],[86.30082702636724,20.04222106933622],[86.30110931396501,20.042222976684798],[86.30305480957031,20.0402774810791]]],[[[86.42639160156244,20.038610458374194],[86.4261093139649,20.038330078125],[86.42555236816412,20.03833389282238],[86.42472076416033,20.03750038147001]]],[[[86.29499816894548,20.049722671508903],[86.29555511474604,20.04916572570812],[86.29582977294928,20.04916572570812],[86.29638671875006,20.049722671508903]]],[[[86.27027893066412,20.058057785034123],[86.26999664306635,20.057781219482536],[86.26999664306635,20.057220458984602],[86.27027893066412,20.056943893432617]]],[[[86.26335144042986,20.058059692382926],[86.26167297363287,20.056390762329215],[86.26139068603544,20.056390762329215],[86.26029205322283,20.05528068542486]]],[[[86.43722534179716,20.05944442749046],[86.43805694580095,20.058610916137923],[86.43776702880865,20.05832099914562],[86.`,
  `43750000000017,20.05833244323736]]],[[[86.49111175537126,20.14972305297863],[86.4913864135745,20.14944458007824],[86.49166870117205,20.14944458007824],[86.49166870117205,20.14805412292492]]],[[[86.50166320800787,20.175840377807845],[86.50195312500017,20.175559997558707],[86.5025024414062,20.175559997558707],[86.50277709960943,20.17527961730974]]],[[[86.55297088623053,20.205270767211914],[86.55261230468778,20.205270767211914],[86.55268859863298,20.205810546875227],[86.5533294677735,20.206417083740405]]],[[[86.79166412353516,20.373611450195312],[86.79194641113287,20.373334884643498],[86.79222106933588,20.373334884643498],[86.79250335693365,20.373056411743107]]],[[[86.79390716552763,20.37993049621599],[86.79435729980486,20.379669189453068],[86.79469299316435,20.37936973571783],[86.79490661621094,20.379070281982422]]],[[[86.79305267333984,20.38417053222679],[86.792778015137,20.383890151977653],[86.79110717773455,20.385562896728516],[86.79165649414057,20.38611030578619]]],[[[86.80278015136719,20.420833587646484],[86.80361175537121,20.41999816894554],[86.80388641357439,20.41999816894554],[86.80416870117193,20.41971969604515]]],[[[86.7897262573245,20.387609481811637],[86.78939819335955,20.3875408172608],[86.7889785766601,20.387769699096737],[86.78904724121094,20.3881511688233]]],[[[86.80272674560547,20.45947265625],[86.8025970458985,20.45947265625],[86.80202484130865,20.459537506103516],[86.80152130126982,20.459672927856445]]],[[[86.80527496337896,20.491945266723633],[86.80638885498064,20.490833282470703],[86.80638885498064,20.490554809570312],[86.80694580078142,20.49000167846691]]],[[[86.87416076660162,20.673610687256087],[86.87388610839861,20.67333030700695],[86.87361145019543,20.6733341217041],[86.87319946289068,20.67314338684082]]],[[[86.7980575561524,20.691942214965934],[86.79784393310553,20.69030570983898],[86.7976303100586,20.689821243286246],[86.7976303100586,20.689226150512752]]],[[[87.00302124023455,20.710790634155273],[87.0023040771485,20.710332870483512],[87.00`,
  `216674804699,20.710599899291992],[87.00216674804699,20.710872650146598]]],[[[87.00851440429682,20.708122253417912],[87.00765991210943,20.707988739013786],[87.00522613525419,20.707990646362532],[87.00444793701178,20.708061218261776]]],[[[87.05751037597685,20.744358062744197],[87.05760955810553,20.743949890136832],[87.05742645263678,20.743679046630973],[87.05712890625028,20.743869781494254]]],[[[87.07055664062517,20.73621368408203],[87.07038879394537,20.735515594482592],[87.06999969482422,20.73527717590349],[87.0694427490235,20.735834121704045]]],[[[87.09083557128912,20.75752067565918],[87.09111022949213,20.757186889648438],[87.09140014648443,20.756881713867244],[87.09172058105486,20.756622314453125]]],[[[86.87,20.77],[87.0,20.72],[86.86,20.66],[86.88,20.73],[86.77,20.65],[86.87,20.77]]],[[[86.87527465820318,20.775833129882756],[86.87555694580107,20.775554656982365],[86.87611389160185,20.775554656982365],[86.87694549560564,20.774723052978572]]],[[[86.86499023437506,20.78111076354992],[86.86528015136713,20.78083992004389],[86.86554718017584,20.78083992004389],[86.86583709716825,20.780559539794922]]],[[[86.98416900634766,20.782222747802678],[86.98444366455107,20.781944274902287],[86.98500061035168,20.781944274902287],[86.98611450195318,20.78083419799833]]],[[[86.94812774658209,20.784570693969954],[86.94813537597662,20.78423690795921],[86.94777679443365,20.783901214599723],[86.94728088378935,20.783901214599723]]],[[[86.8819427490235,20.788610458374023],[86.88223266601591,20.788330078125227],[86.88666534423845,20.788335800171012],[86.886947631836,20.788055419922046]]],[[[87.01651000976591,20.802829742431584],[87.01651000976591,20.80067062377958],[87.01679229736334,20.79904937744169],[87.01679229736334,20.79824066162115]]],[[[87.12388610839872,21.51972007751465],[87.12388610839872,21.517778396606502],[87.12375640869158,21.51749992370634],[87.12361145019537,21.514999389648438]]],[[[86.08,22.53],[86.43,22.3],[86.5,22.34],[86.72,22.22],[86.72,22.14],[86.97,22.08],[87.03,21.87`,
  `],[87.23,21.95],[87.27,21.8],[87.47,21.73],[87.48,21.61],[87.11,21.52],[86.82,21.19],[86.97,20.82],[86.83,20.77],[86.76,20.61],[87.05,20.71],[86.73,20.48],[86.77,20.33],[86.46,20.16],[86.47,20.1],[86.56,20.2],[86.39,19.98],[86.25,20.05],[86.36,19.95],[85.42,19.62],[84.78,19.11],[84.67,19.16],[84.59,19.01],[84.57,19.07],[84.42,19.01],[84.43,18.91],[84.31,18.78],[83.89,18.81],[83.62,19.15],[83.53,19.01],[83.46,19.07],[83.46,18.95],[83.31,18.99],[83.4,18.83],[83.21,18.72],[83.13,18.77],[83.01,18.64],[83.09,18.54],[83.02,18.44],[83.05,18.38],[82.9,18.36],[82.8,18.44],[82.63,18.23],[82.47,18.54],[82.36,18.41],[82.33,18.32],[82.39,18.31],[82.31,18.2],[82.36,18.13],[82.27,17.99],[82.02,18.06],[81.61,17.82],[81.38,17.81],[81.53,18.26],[81.74,18.35],[81.95,18.56],[81.89,18.65],[82.08,18.71],[82.24,18.91],[82.16,19.13],[82.18,19.42],[82.02,19.5],[82.06,19.78],[81.85,19.91],[81.87,20.04],[81.94,20.1],[82.02,20.01],[82.23,20.0],[82.34,19.83],[82.44,19.9],[82.59,19.86],[82.59,19.77],[82.7,19.83],[82.71,19.99],[82.39,20.06],[82.43,20.43],[82.32,20.55],[82.35,20.88],[82.46,20.82],[82.64,21.15],[82.96,21.18],[83.12,21.1],[83.27,21.38],[83.4,21.35],[83.33,21.5],[83.38,21.61],[83.48,21.63],[83.42,21.68],[83.47,21.78],[83.58,21.84],[83.53,22.03],[83.63,22.21],[84.0,22.37],[83.99,22.53],[84.29,22.34],[85.06,22.48],[85.11,22.29],[84.99,22.08],[85.1,22.1],[85.23,22.0],[85.36,22.15],[85.68,22.05],[85.8,22.11],[85.76,21.99],[85.91,21.97],[86.04,22.31],[85.96,22.48],[86.08,22.53]]]]}},{"type":"Feature","properties":{"n":"Puducherry"},"geometry":{"type":"MultiPolygon","coordinates":[[[[79.84485626220732,10.826532363891886],[79.84485626220732,10.826251029968262],[79.84541320800793,10.826251029968262],[79.84541320800793,10.825691223144588]]],[[[79.75,10.98],[79.85,10.98],[79.85,10.81],[79.7,10.92],[79.75,10.98]]],[[[79.69,12.0],[79.74,11.91],[79.84,11.94],[79.8,11.81],[79.66,11.87],[79.72,11.89],[79.64,11.98],[79.69,12.0]]],[[[75.37,12.15],[75.26,12.02],[75.3,11.95],[75.22,12.1],[75.37,12.15]]`,
  `],[[[82.26568603515653,16.702920913696232],[82.26568603515653,16.70263099670433],[82.26791381835943,16.70263862609869],[82.26791381835943,16.702362060546875]]],[[[82.21096801757807,16.727939605713004],[82.2147827148437,16.7252006530764],[82.2204208374024,16.718309402465877],[82.22704315185564,16.71718025207548]]]]}},{"type":"Feature","properties":{"n":"Punjab"},"geometry":{"type":"Polygon","coordinates":[[[75.87,32.49],[75.93,32.42],[75.62,32.23],[75.66,32.16],[75.58,32.08],[75.89,31.95],[76.17,31.31],[76.3,31.32],[76.36,31.44],[76.43,31.28],[76.63,31.23],[76.61,31.0],[76.85,30.79],[76.69,30.75],[76.86,30.68],[76.93,30.39],[76.76,30.44],[76.72,30.33],[76.55,30.26],[76.64,30.21],[76.6,30.08],[76.45,30.1],[76.41,30.2],[76.32,30.11],[76.2,30.16],[76.25,30.1],[76.17,29.93],[76.24,29.87],[76.04,29.75],[75.77,29.83],[75.57,29.74],[75.44,29.81],[75.22,29.55],[75.16,29.66],[75.23,29.75],[75.18,29.84],[75.09,29.81],[75.08,29.92],[74.99,29.86],[74.8,29.99],[74.64,29.9],[73.89,29.97],[73.97,30.18],[73.87,30.38],[74.56,31.07],[74.69,31.1],[74.5,31.14],[74.64,31.46],[74.57,31.5],[74.52,31.72],[74.6,31.89],[74.91,32.07],[75.24,32.09],[75.36,32.23],[75.33,32.34],[75.47,32.34],[75.5,32.28],[75.87,32.58],[75.87,32.49]]]}},{"type":"Feature","properties":{"n":"Rajasthan"},"geometry":{"type":"Polygon","coordinates":[[[73.89,29.98],[74.52,29.94],[74.55,29.87],[74.47,29.79],[74.61,29.75],[74.61,29.53],[74.53,29.45],[74.6,29.33],[74.84,29.4],[75.08,29.23],[75.4,29.26],[75.36,29.14],[75.51,29.01],[75.47,28.93],[75.56,28.61],[75.77,28.41],[75.92,28.37],[76.09,28.16],[75.94,28.09],[76.04,28.07],[75.92,27.93],[75.96,27.86],[76.22,27.84],[76.15,28.0],[76.18,28.06],[76.34,28.03],[76.29,28.18],[76.47,28.15],[76.45,28.05],[76.54,28.04],[76.54,27.97],[76.81,28.22],[76.9,28.2],[76.96,28.14],[76.9,27.66],[77.08,27.74],[77.04,27.82],[77.3,27.8],[77.34,27.53],[77.43,27.4],[77.61,27.34],[77.67,27.2],[77.5,27.1],[77.76,27.02],[77.42,26.87],[77.45,26.75],[77.5,26.85],[77.75,26.94],[78.02,26.86],[78.11,26`,
  `.95],[78.26,26.92],[78.18,26.79],[78.1,26.8],[78.09,26.68],[77.89,26.66],[77.81,26.55],[77.12,26.24],[76.75,25.91],[76.59,25.87],[76.48,25.72],[76.56,25.44],[76.77,25.31],[77.21,25.31],[77.28,25.42],[77.36,25.41],[77.4,25.11],[76.85,25.01],[76.95,24.87],[76.8,24.82],[77.03,24.71],[77.06,24.57],[76.97,24.46],[76.91,24.54],[76.81,24.53],[76.94,24.21],[76.9,24.13],[76.7,24.17],[76.69,24.29],[76.53,24.16],[76.47,24.23],[76.22,24.22],[76.19,24.33],[76.13,24.1],[75.96,24.03],[75.98,23.93],[75.78,23.85],[75.7,23.9],[75.68,23.76],[75.58,23.8],[75.46,23.92],[75.51,24.05],[75.7,23.97],[75.83,24.08],[75.74,24.14],[75.83,24.25],[75.73,24.41],[75.79,24.48],[75.91,24.46],[75.84,24.73],[75.22,24.72],[75.21,24.91],[75.31,24.81],[75.42,24.86],[75.26,24.89],[75.35,25.04],[75.16,25.05],[75.04,24.86],[74.85,24.97],[74.85,24.79],[75.02,24.75],[74.89,24.66],[74.8,24.8],[74.82,24.67],[74.71,24.51],[74.86,24.47],[74.75,24.28],[74.89,24.26],[74.99,24.03],[74.91,23.87],[74.94,23.63],[74.61,23.46],[74.52,23.33],[74.75,23.21],[74.32,23.06],[73.97,23.38],[73.89,23.34],[73.83,23.45],[73.63,23.45],[73.66,23.62],[73.51,23.62],[73.51,23.7],[73.36,23.79],[73.42,23.93],[73.37,24.13],[73.25,24.01],[73.08,24.18],[73.23,24.36],[73.08,24.39],[73.09,24.49],[72.92,24.33],[72.73,24.36],[72.7,24.46],[72.54,24.51],[72.46,24.41],[72.44,24.5],[72.25,24.58],[72.35,24.62],[72.17,24.61],[72.05,24.71],[71.94,24.63],[71.88,24.68],[71.86,24.6],[71.8,24.67],[71.3,24.61],[71.12,24.67],[70.89,25.14],[70.67,25.39],[70.67,25.7],[70.28,25.7],[70.1,25.94],[70.17,26.55],[69.82,26.59],[69.48,26.81],[69.59,27.18],[70.02,27.56],[70.16,27.83],[70.37,28.01],[70.56,28.02],[70.76,27.72],[70.88,27.7],[71.9,27.96],[71.93,28.13],[72.18,28.36],[72.38,28.76],[72.94,29.03],[73.27,29.56],[73.39,29.94],[73.97,30.2],[73.89,29.98]]]}},{"type":"Feature","properties":{"n":"Sikkim"},"geometry":{"type":"Polygon","coordinates":[[[88.65,28.1],[88.83,28.02],[88.88,27.89],[88.77,27.56],[88.91,27.28],[88.73,27.14],[88.56,27.19],[88.43,27.08],[88.09,2`,
  `7.14],[88.02,27.22],[88.05,27.5],[88.2,27.84],[88.12,27.95],[88.65,28.1]]]}},{"type":"Feature","properties":{"n":"Tamil Nadu"},"geometry":{"type":"MultiPolygon","coordinates":[[[[77.55596160888678,8.079030990600813],[77.55596160888678,8.078750610351847],[77.55625152587919,8.078750610351847],[77.55625152587919,8.07847118377697]]],[[[78.1154174804688,8.616808891296387],[78.1154174804688,8.61597061157238],[78.11569213867182,8.615973472595442],[78.11569213867182,8.615694999694881]]],[[[78.1212463378908,8.6173610687257],[78.1212463378908,8.616806983947981],[78.12097167968756,8.616808891296387],[78.12097167968756,8.616531372070312]]],[[[78.12014007568376,8.637921333313272],[78.12014007568376,8.637640953063908],[78.1204071044923,8.637640953063908],[78.1204071044923,8.637359619140852]]],[[[78.12763977050787,8.647921562195052],[78.12763977050787,8.645140647888184],[78.12790679931635,8.645140647888184],[78.12790679931635,8.64346790313732]]],[[[78.11708068847673,8.656530380249023],[78.11708068847673,8.65542030334484],[78.1173629760745,8.65542030334484],[78.1173629760745,8.65485858917259]]],[[[78.20847320556646,8.840970993041992],[78.20847320556646,8.840693473816088],[78.20903015136719,8.840693473816088],[78.20903015136719,8.84041786193859]]],[[[78.22486114501953,8.873749732971248],[78.22486114501953,8.873191833496207],[78.22541809082048,8.873193740844783],[78.22541809082048,8.87291622161888]]],[[[78.25290679931646,8.957921028137264],[78.25290679931646,8.957360267639103],[78.25319671630888,8.957362174987907],[78.25319671630888,8.957083702087516]]],[[[78.49180603027372,9.093194007873535],[78.49180603027372,9.092915534973145],[78.49208831787115,9.09292125701927],[78.49208831787115,9.09235954284668]]],[[[78.53930664062528,9.105973243713379],[78.53930664062528,9.105694770812988],[78.53958129882818,9.105694770812988],[78.53958129882818,9.105417251586914]]],[[[78.58041381835943,9.112361907958984],[78.58041381835943,9.11208438873291],[78.58097076416021,9.11208438873291],[78.5809707641`,
  `6021,9.11180591583252]]],[[[78.48791503906256,9.13486099243164],[78.48791503906256,9.134305000305176],[78.48764038085938,9.134309768676815],[78.48764038085938,9.133199691772461]]],[[[78.69625091552763,9.155140876770076],[78.69625091552763,9.153751373291016],[78.69652557373064,9.153751373291016],[78.69652557373064,9.151250839233342]]],[[[78.730697631836,9.15625095367443],[78.730697631836,9.155970573425463],[78.73097229003935,9.155973434448526],[78.73097229003935,9.155694961548136]]],[[[78.82819366455084,9.171250343322981],[78.8281860351563,9.17097187042242],[78.82847595214838,9.17097187042242],[78.82847595214838,9.170415878296126]]],[[[78.94069671630865,9.184582710266227],[78.94069671630865,9.184305191040323],[78.94042205810575,9.184311866760368],[78.94042205810575,9.184030532836914]]],[[[78.96765136718761,9.189310073852482],[78.96765136718761,9.189029693603516],[78.96819305419928,9.189029693603516],[78.96819305419928,9.188470840454158]]],[[[79.07013702392572,9.2081947326663],[79.07013702392572,9.207082748413143],[79.06986236572271,9.207082748413143],[79.06986236572271,9.206805229187069]]],[[[79.14206695556658,9.214860916137638],[79.14206695556658,9.214029312133846],[79.14180755615263,9.214029312133846],[79.14180755615263,9.213471412658805]]],[[[79.12568664550798,9.21792030334467],[79.12568664550798,9.217641830444279],[79.12819671630865,9.217641830444279],[79.12819671630865,9.217362403869629]]],[[[79.23235321044928,9.244589805603027],[79.23235321044928,9.24431037902832],[79.23264312744135,9.24431037902832],[79.23264312744135,9.244031906128157]]],[[[79.18402862548845,9.249030113220272],[79.18402862548845,9.248749732971476],[79.18430328369146,9.248749732971476],[79.18430328369146,9.248190879821948]]],[[[79.21902465820318,9.250971794128418],[79.21902465820318,9.250694274902514],[79.21930694580095,9.250694274902514],[79.21930694580095,9.250415802002124]]],[[[79.31,9.33],[79.44,9.16],[79.21,9.25],[79.31,9.33]]],[[[79.52930450439459,9.384028434753702],[79.5291366577149,9.3`,
  `84028434753702],[79.52930450439459,9.38419723510765],[79.52930450439459,9.384028434753702]]],[[[79.5300903320313,9.385957717895451],[79.53013610839872,9.385693550109863],[79.5299835205081,9.385693550109863],[79.5300903320313,9.385957717895451]]],[[[79.5300903320313,9.385957717895451],[79.53008270263678,9.386117935180778],[79.53006744384771,9.38638019561779],[79.53012084960943,9.386585235595646]]],[[[79.52986145019548,9.388750076294002],[79.53013610839872,9.388750076294002],[79.53013610839872,9.388317108154467],[79.52993011474615,9.38863563537592]]],[[[79.52986145019548,9.388750076294002],[79.52970886230474,9.388955116272086],[79.52967834472656,9.389115333557186],[79.52986145019548,9.389020919800032]]],[[[79.52930450439459,9.389304161071891],[79.52958679199247,9.389310836792163],[79.52958679199247,9.389160156249943],[79.52930450439459,9.389304161071891]]],[[[79.52930450439459,9.389304161071891],[79.52894592285162,9.389602661132812],[79.52864837646513,9.389852523803825],[79.52930450439459,9.389860153198185]]],[[[79.52864837646513,9.389852523803825],[79.52835845947271,9.39013767242426],[79.5287475585938,9.390140533447322],[79.52864837646513,9.389852523803825]]],[[[79.706802368164,10.28819465637207],[79.706802368164,10.287917137145996],[79.70707702636724,10.287921905517635],[79.70707702636724,10.287640571594181]]],[[[79.69790649414062,10.29013919830328],[79.69790649414062,10.289860725402889],[79.69904327392595,10.289860725402889],[79.69902801513689,10.289583206176815]]],[[[79.69569396972685,10.290970802307072],[79.69569396972685,10.290416717529581],[79.69597625732439,10.290419578552246],[79.69597625732439,10.29013919830328]]],[[[79.6912460327149,10.297920227051009],[79.6912460327149,10.297639846801871],[79.69152832031278,10.297639846801871],[79.69152832031278,10.297360420226994]]],[[[79.68597412109403,10.298472404480151],[79.68597412109403,10.298195838928336],[79.68624877929705,10.298195838928336],[79.68624877929705,10.297639846801871]]],[[[79.62264251709013,10.29986190`,
  `7958984],[79.62264251709013,10.29958438873291],[79.62458038330107,10.29958438873291],[79.62458038330107,10.29930591583252]]],[[[79.6081924438476,10.302639961242733],[79.6081924438476,10.302359580993596],[79.60847473144537,10.302362442016658],[79.60847473144537,10.302082061767692]]],[[[79.6187515258789,10.308751106262491],[79.6187515258789,10.3084726333621],[79.62041473388672,10.3084726333621],[79.62041473388672,10.308195114135799]]],[[[79.62403106689447,10.308751106262491],[79.62403106689447,10.307916641235636],[79.62375640869146,10.307921409607104],[79.62375640869146,10.307080268859806]]],[[[79.63153076171875,10.308751106262491],[79.63153076171875,10.308195114135799],[79.63180541992216,10.308195114135799],[79.63180541992216,10.307359695434684]]],[[[79.69985961914068,10.309582710266284],[79.69985961914068,10.309305191039982],[79.70041656494146,10.309310913085938],[79.70041656494146,10.309030532837141]]],[[[79.67736053466803,10.309861183166447],[79.67736053466803,10.309582710266284],[79.6779174804688,10.309582710266284],[79.6779174804688,10.309305191039982]]],[[[79.6898498535158,10.310420989990291],[79.6898498535158,10.310150146484432],[79.69040679931635,10.310150146484432],[79.69040679931635,10.309861183166447]]],[[[79.60875701904325,10.311250686645508],[79.60875701904325,10.3109712600708],[79.6093063354495,10.310973167419604],[79.6093063354495,10.310694694519043]]],[[[79.69597625732439,10.321251869201944],[79.69597625732439,10.32097053527832],[79.69652557373064,10.32097053527832],[79.69652557373064,10.32069587707548]]],[[[79.63208007812517,10.33319377899187],[79.63208007812517,10.332916259765568],[79.63236236572277,10.332921028137434],[79.63236236572277,10.332640647888468]]],[[[79.62568664550793,10.3437509536746],[79.62568664550793,10.343470573425236],[79.62680816650396,10.343473434448299],[79.62680816650396,10.343193054199332]]],[[[79.83902740478533,11.236530303955249],[79.83902740478533,11.236251831054858],[79.83985900878912,11.236251831054858],[79.83985900878912`,
  `,11.235971450805891]]],[[[79.82707977294928,11.237361907959212],[79.82707977294928,11.237080574035758],[79.82819366455084,11.23708438873291],[79.82819366455084,11.236805915832747]]],[[[79.99124908447283,12.251251220703182],[79.99124908447283,12.250970840454215],[79.9915313720706,12.250970840454215],[79.9915313720706,12.250691413879565]]],[[[80.3229064941408,13.438470840454215],[80.3229064941408,13.437919616699219],[80.32347106933611,13.437919616699219],[80.32347106933611,13.437639236450252]]],[[[80.08,13.53],[80.33,13.37],[80.33,13.44],[80.25,12.78],[80.16,12.47],[80.02,12.34],[79.84,11.94],[79.74,11.91],[79.75,11.99],[79.64,11.98],[79.72,11.89],[79.66,11.87],[79.8,11.81],[79.76,11.56],[79.86,10.98],[79.73,10.99],[79.7,10.92],[79.85,10.81],[79.88,10.3],[79.74,10.28],[79.63,10.36],[79.55,10.31],[79.74,10.28],[79.55,10.35],[79.29,10.26],[79.23,10.14],[79.27,10.04],[78.9,9.49],[79.03,9.32],[79.19,9.28],[78.83,9.27],[78.37,9.09],[78.17,8.88],[78.16,8.77],[78.23,8.75],[78.1,8.65],[78.07,8.37],[77.55,8.08],[77.32,8.12],[77.09,8.3],[77.27,8.54],[77.16,8.74],[77.24,8.86],[77.13,9.01],[77.4,9.5],[77.34,9.6],[77.15,9.61],[77.26,9.96],[77.19,10.1],[77.28,10.21],[77.22,10.34],[76.97,10.21],[76.82,10.3],[76.8,10.63],[76.87,10.63],[76.9,10.77],[76.65,10.92],[76.79,11.04],[76.69,11.14],[76.73,11.21],[76.45,11.18],[76.54,11.35],[76.24,11.46],[76.23,11.56],[76.5,11.7],[76.56,11.61],[76.84,11.57],[76.9,11.78],[77.0,11.8],[77.11,11.71],[77.24,11.8],[77.42,11.75],[77.48,11.93],[77.66,11.94],[77.77,12.11],[77.46,12.24],[77.61,12.36],[77.59,12.66],[77.73,12.66],[77.83,12.86],[77.92,12.88],[77.98,12.8],[78.05,12.84],[78.22,12.75],[78.19,12.68],[78.45,12.61],[78.7,13.06],[78.88,13.09],[78.92,13.02],[78.98,13.08],[79.15,13.01],[79.22,13.14],[79.31,13.1],[79.42,13.19],[79.37,13.3],[79.43,13.32],[79.58,13.25],[79.67,13.28],[79.74,13.19],[79.72,13.27],[79.93,13.34],[80.04,13.48],[79.99,13.53],[80.08,13.53]]]]}},{"type":"Feature","properties":{"n":"Tripura"},"geometry":{"type":"Polygon","coordi`,
  `nates":[[[92.19,24.52],[92.27,24.39],[92.21,24.25],[92.33,24.19],[92.32,23.87],[92.22,23.66],[92.18,23.74],[92.07,23.64],[91.96,23.73],[91.98,23.48],[91.77,23.26],[91.84,23.09],[91.62,22.94],[91.42,23.28],[91.42,23.06],[91.36,23.1],[91.16,23.74],[91.22,23.74],[91.28,23.98],[91.38,23.98],[91.38,24.11],[91.6,24.08],[91.67,24.23],[91.76,24.14],[91.74,24.25],[91.9,24.14],[91.92,24.34],[92.12,24.38],[92.19,24.52]]]}},{"type":"Feature","properties":{"n":"Uttar Pradesh"},"geometry":{"type":"Polygon","coordinates":[[[77.58,30.41],[77.93,30.25],[77.7,29.87],[77.79,29.68],[77.95,29.71],[77.99,29.55],[78.33,29.8],[78.41,29.77],[78.61,29.56],[78.92,29.46],[78.71,29.32],[78.85,29.26],[78.9,29.15],[79.13,29.13],[79.16,29.02],[79.36,28.97],[79.41,28.86],[79.77,28.89],[79.78,28.81],[79.85,28.84],[79.97,28.72],[80.12,28.83],[80.52,28.55],[80.51,28.67],[80.57,28.69],[81.21,28.36],[81.32,28.13],[81.45,28.16],[81.89,27.86],[82.07,27.92],[82.45,27.68],[82.71,27.72],[82.74,27.5],[83.19,27.45],[83.32,27.33],[83.39,27.48],[83.62,27.47],[83.92,27.33],[84.05,26.89],[84.24,26.86],[84.23,26.74],[84.41,26.63],[84.08,26.64],[84.05,26.54],[83.9,26.52],[83.9,26.45],[84.17,26.37],[84.16,26.25],[84.01,26.24],[84.0,26.18],[84.17,25.99],[84.53,25.88],[84.63,25.73],[84.49,25.68],[84.33,25.74],[84.29,25.66],[84.09,25.72],[83.84,25.44],[83.34,25.18],[83.35,24.87],[83.54,24.62],[83.39,24.5],[83.45,24.36],[83.19,23.92],[82.94,23.88],[82.66,24.12],[82.76,24.29],[82.71,24.39],[82.71,24.56],[82.8,24.55],[82.76,24.65],[82.43,24.71],[82.41,24.6],[82.29,24.61],[82.24,24.78],[82.17,24.74],[82.2,24.82],[81.96,24.83],[81.9,25.01],[81.6,25.06],[81.57,25.2],[81.48,25.07],[81.27,25.17],[81.21,24.93],[81.13,24.89],[81.08,24.95],[80.8,24.94],[80.88,25.2],[80.83,25.11],[80.7,25.14],[80.78,25.06],[80.67,25.05],[80.59,25.16],[80.61,25.07],[80.28,25.02],[80.42,25.17],[80.26,25.43],[79.85,25.24],[79.86,25.1],[79.57,25.18],[79.49,25.08],[79.4,25.11],[79.49,25.27],[79.35,25.27],[79.29,25.34],[79.3,25.13],[79.13,25.11],[79.08,2`,
  `5.19],[79.02,25.14],[79.0,25.28],[79.0,25.2],[78.87,25.17],[78.95,25.35],[78.88,25.34],[78.84,25.23],[78.78,25.3],[78.98,25.38],[78.9,25.45],[78.93,25.56],[78.83,25.51],[78.83,25.43],[78.73,25.5],[78.81,25.43],[78.76,25.36],[78.65,25.44],[78.43,25.29],[78.57,25.26],[78.62,24.96],[78.78,24.81],[78.75,24.6],[78.88,24.64],[78.97,24.35],[78.79,24.18],[78.51,24.39],[78.41,24.28],[78.34,24.31],[78.36,24.39],[78.22,24.53],[78.27,24.67],[78.16,24.86],[78.33,25.0],[78.33,25.09],[78.44,25.13],[78.3,25.37],[78.43,25.56],[78.81,25.62],[78.75,25.75],[78.86,25.8],[79.0,26.08],[78.94,26.14],[79.13,26.32],[79.13,26.44],[78.98,26.57],[78.99,26.68],[78.72,26.8],[78.57,26.76],[78.35,26.87],[78.21,26.84],[78.22,26.95],[78.02,26.86],[77.75,26.94],[77.43,26.77],[77.42,26.87],[77.76,27.02],[77.51,27.07],[77.67,27.2],[77.61,27.34],[77.43,27.4],[77.31,27.61],[77.28,27.81],[77.54,27.95],[77.47,28.09],[77.54,28.25],[77.3,28.56],[77.32,28.72],[77.19,28.8],[77.09,29.6],[77.19,29.92],[77.41,30.11],[77.58,30.41]]]}},{"type":"Feature","properties":{"n":"Uttaranchal"},"geometry":{"type":"Polygon","coordinates":[[[79.19,31.35],[79.41,31.04],[79.59,30.94],[79.85,30.98],[80.22,30.76],[80.22,30.58],[80.58,30.49],[81.02,30.25],[80.37,29.75],[80.41,29.59],[80.24,29.44],[80.3,29.21],[80.15,29.1],[79.99,28.72],[79.85,28.84],[79.78,28.81],[79.77,28.89],[79.41,28.86],[79.36,28.97],[79.16,29.02],[79.13,29.13],[78.9,29.15],[78.85,29.26],[78.71,29.32],[78.92,29.46],[78.61,29.56],[78.47,29.75],[78.33,29.8],[77.99,29.55],[77.95,29.71],[77.79,29.68],[77.7,29.87],[77.93,30.25],[77.56,30.42],[77.81,30.53],[77.69,30.77],[77.89,31.15],[78.36,31.29],[78.47,31.2],[78.8,31.21],[78.94,31.11],[79.0,31.12],[78.92,31.33],[79.05,31.47],[79.19,31.35]]]}},{"type":"Feature","properties":{"n":"West Bengal"},"geometry":{"type":"MultiPolygon","coordinates":[[[[88.018608093262,21.57277870178217],[88.01889038085955,21.572500228882006],[88.01944732666033,21.572500228882006],[88.01972198486334,21.57220840454113]]],[[[88.49771118164068,`,
  `21.599754333496378],[88.49829864501982,21.599428176880167],[88.49888610839872,21.599166870117244],[88.49888610839872,21.598611831665096]]],[[[88.17778015136736,21.601110458374194],[88.17778015136736,21.600830078125],[88.1780548095706,21.60083389282238],[88.17833709716814,21.60055541992199]]],[[[88.83472442626959,21.607221603393725],[88.8349990844726,21.606946945190487],[88.83528137207037,21.606950759887695],[88.83638000488298,21.605831146240405]]],[[[88.72885131835943,21.637081146240348],[88.7288665771485,21.63659095764166],[88.72889709472685,21.636129379272518],[88.72895050048822,21.635726928710938]]],[[[88.53721618652372,21.638620376586914],[88.53749847412126,21.638061523437727],[88.53778076171903,21.638061523437727],[88.53832244873053,21.637500762939624]]],[[[88.89235687255888,21.652090072631836],[88.89261627197283,21.651672363281364],[88.8929061889649,21.651388168335018],[88.89375305175781,21.650558471679858]]],[[[88.77194213867193,21.653062820434513],[88.77249908447266,21.652500152588175],[88.7727813720706,21.652500152588175],[88.7727813720706,21.652221679687614]]],[[[88.96576690673834,21.64153480529808],[88.96607971191423,21.641298294067383],[88.96637725830107,21.641029357910327],[88.96675872802763,21.64083290100109]]],[[[88.63444519042974,21.65666580200201],[88.63416290283203,21.656389236450423],[88.63388824462896,21.656391143798828],[88.63381195068376,21.656312942504826]]],[[[88.57688140869169,21.691734313964787],[88.57701873779303,21.691371917724837],[88.5771789550783,21.69111061096214],[88.57729339599638,21.690811157226733]]],[[[88.59194183349621,21.694166183471623],[88.59306335449224,21.693061828613395],[88.59333038330072,21.693061828613395],[88.59388732910185,21.692499160766886]]],[[[88.98448944091825,21.70568847656267],[88.98509216308622,21.70554924011236],[88.9852828979495,21.705562591552678],[88.9855575561524,21.705280303955135]]],[[[88.80665588378912,21.70667266845703],[88.80722045898443,21.706111907959098],[88.80750274658232,21.706111907959098],[88.`,
  `80805206298857,21.705554962158317]]],[[[88.31108093261736,21.7063503265382],[88.31166839599626,21.706111907959098],[88.31527709960955,21.706111907959098],[88.31555175781256,21.705833435058707]]],[[[88.45403289794928,21.709341049194563],[88.45444488525419,21.70916748046875],[88.45500183105497,21.708610534668196],[88.45500183105497,21.70833015441923]]],[[[88.69712066650408,21.712879180908203],[88.69734191894548,21.7126407623291],[88.69750213623064,21.712280273437557],[88.6976699829101,21.711921691894645]]],[[[88.20450592041021,21.721181869506893],[88.20465850830095,21.7206401824954],[88.20504760742205,21.719707489013842],[88.20583343505865,21.718889236450366]]],[[[89.05920410156256,21.721803665161133],[89.05941772460943,21.72173309326172],[89.05978393554693,21.721813201904297],[89.05983734130888,21.721942901611442]]],[[[88.97799682617216,21.72687530517578],[88.97860717773466,21.726650238037337],[88.97914123535185,21.726390838623047],[88.97966003417974,21.72617912292492]]],[[[88.54566955566423,21.73612976074247],[88.54611206054693,21.736120223999137],[88.5465621948245,21.736141204833984],[88.54701232910173,21.73612976074247]]],[[[88.19560241699247,21.724479675293026],[88.19499969482428,21.72417068481468],[88.1947326660158,21.724451065063477],[88.1947326660158,21.725561141968]]],[[[88.88305664062494,21.745279312134016],[88.88276672363287,21.745000839233455],[88.88360595703153,21.745000839233455],[88.8838882446289,21.74472045898466]]],[[[88.41233825683594,21.731260299682845],[88.4127197265625,21.730688095093],[88.41306304931669,21.73009872436529],[88.41342926025419,21.72954177856451]]],[[[88.22,21.76],[88.31,21.68],[88.29,21.56],[88.22,21.62],[88.22,21.76]]],[[[88.92710113525419,21.761949539184684],[88.92761230468756,21.7619438171389],[88.9281616210938,21.761949539184684],[88.92874908447271,21.761949539184684]]],[[[88.36538696289091,21.76416587829584],[88.36593627929716,21.76415061950695],[88.36645507812506,21.764072418213175],[88.36688232421903,21.76392364501976]]],[[[8`,
  `9.00511932373075,21.764976501464787],[89.00567626953153,21.76489067077665],[89.00610351562517,21.764932632446346],[89.006576538086,21.764873504638786]]],[[[88.83,21.77],[88.85,21.62],[88.76,21.7],[88.83,21.77]]],[[[88.38490295410173,21.76444053649925],[88.38545227050798,21.764160156250057],[88.38599395751982,21.76386070251465],[88.38643646240251,21.76346969604515]]],[[[88.2005462646485,21.768608093261662],[88.20055389404308,21.768056869506836],[88.2008361816408,21.767778396606673],[88.2008361816408,21.767499923706282]]],[[[88.2827911376956,21.76501083374029],[88.28250122070312,21.76501083374029],[88.28250122070312,21.76527786254877],[88.28056335449236,21.767219543457315]]],[[[88.58222198486357,21.777780532837028],[88.58249664306658,21.77750015258806],[88.58304595947266,21.77750015258806],[88.5833358764649,21.777219772339095]]],[[[88.30249023437517,21.72456169128418],[88.30229187011736,21.724090576171932],[88.30216217041021,21.72357749938965],[88.30194854736345,21.723150253296012]]],[[[88.50527954101562,21.782989501953352],[88.50389099121094,21.78138923645048],[88.50377655029303,21.781391143799055],[88.50365447998075,21.781303405761946]]],[[[89.0,21.79],[89.0,21.72],[88.95,21.76],[89.0,21.79]]],[[[88.60972595214872,21.790279388427905],[88.61000061035162,21.790000915527344],[88.61165618896484,21.790000915527344],[88.61194610595709,21.789720535278548]]],[[[88.27396392822271,21.790790557861442],[88.27464294433611,21.79063987731962],[88.27536773681669,21.790744781494368],[88.27609252929716,21.790609359741268]]],[[[88.183334350586,21.78750038146984],[88.18222045898443,21.78638839721708],[88.18194580078142,21.786390304565487],[88.18176269531267,21.786203384399357]]],[[[88.45861053466803,21.788650512695483],[88.45910644531267,21.78864860534668],[88.45952606201178,21.788789749145735],[88.45995330810558,21.78893089294445]]],[[[88.71620178222673,21.80738067626953],[88.71656799316423,21.807060241699276],[88.71695709228533,21.806720733642578],[88.71736145019548,21.80638122558588`,
  `]]],[[[88.17111206054688,21.808610916137752],[88.17222595214861,21.8075008392334],[88.17222595214861,21.807220458984602],[88.17250061035162,21.806945800781193]]],[[[88.54457092285156,21.810319900512923],[88.54615020751959,21.809921264648494],[88.54728698730474,21.81005096435547],[88.54886627197294,21.80978012084961]]],[[[88.42180633544933,21.81109046936041],[88.42236328125006,21.81107902526867],[88.42290496826178,21.811082839966048],[88.42346954345709,21.811082839966048]]],[[[88.99957275390653,21.811670303344954],[88.99972534179693,21.810832977295036],[88.99973297119152,21.811389923095817],[89.00000000000017,21.811670303344954]]],[[[88.75063323974621,21.79540061950712],[88.75076293945318,21.794710159301815],[88.7508163452149,21.793991088867358],[88.75085449218778,21.793338775634766]]],[[[88.8280792236331,21.804029464721623],[88.82757568359392,21.803447723388672],[88.8270492553711,21.802961349487305],[88.82701110839861,21.802679061889762]]],[[[88.78749847412104,21.745000839233455],[88.78694152832031,21.74443817138672],[88.78666687011724,21.744443893432845],[88.78610992431652,21.7438907623291]]],[[[88.91583251953153,21.825834274291992],[88.91638946533232,21.82527732849121],[88.9166564941408,21.8252925872805],[88.91750335693365,21.824438095092717]]],[[[88.18194580078142,21.825828552246037],[88.18250274658203,21.82527732849121],[88.18250274658203,21.82389068603527],[88.18277740478521,21.823610305786303]]],[[[88.5594482421875,21.829721450805664],[88.55972290039091,21.82944488525385],[88.55999755859392,21.82944488525385],[88.56027984619152,21.82916641235346]]],[[[88.48487854003912,21.834690093994084],[88.48543548584001,21.834594726562443],[88.48597717285173,21.83460807800293],[88.48651885986322,21.834739685058878]]],[[[88.94139099121122,21.84722137451172],[88.94222259521501,21.846389770507926],[88.94222259521501,21.84610939025896],[88.9427795410158,21.845554351806754]]],[[[88.59221649169939,21.850000381469783],[88.59249877929693,21.849718093872013],[88.59305572509771,21.8`,
  `49721908569563],[88.59333038330072,21.849445343017578]]],[[[88.51995849609392,21.854637145996037],[88.52054595947271,21.85416984558117],[88.52083587646513,21.85416984558117],[88.52139282226591,21.853612899780387]]],[[[88.53800201416044,21.853582382202433],[88.53713989257818,21.853246688842717],[88.53656768798834,21.853250503540266],[88.53649139404291,21.853717803955362]]],[[[88.33,21.86],[88.38,21.79],[88.32,21.71],[88.26,21.8],[88.33,21.86]]],[[[88.86,21.87],[88.91,21.73],[88.83,21.78],[88.86,21.87]]],[[[88.582748413086,21.865549087524357],[88.58248901367205,21.86549949645996],[88.5822296142581,21.865518569946403],[88.5819168090822,21.86559104919462]]],[[[88.14,21.88],[88.11,21.63],[88.04,21.68],[88.14,21.88]]],[[[88.78916931152372,21.87861061096197],[88.7894363403322,21.8783283233642],[88.79027557373053,21.878334045410156],[88.79055786132807,21.878055572509766]]],[[[88.98,21.89],[89.03,21.83],[88.97,21.78],[88.98,21.89]]],[[[88.6216659545899,21.897779464721737],[88.62194824218744,21.897510528564453],[88.62222290039068,21.897510528564453],[88.62249755859403,21.89722061157238]]],[[[88.13730621337908,21.895139694213924],[88.13659667968756,21.89439964294462],[88.13601684570312,21.894470214843864],[88.13594818115229,21.895341873168945]]],[[[88.81694793701178,21.901111602783203],[88.81722259521513,21.900833129882812],[88.81777954101591,21.900833129882812],[88.81805419921892,21.900554656982422]]],[[[88.5623397827149,21.897460937500227],[88.56294250488287,21.897409439086857],[88.56349945068365,21.897504806518498],[88.56402587890625,21.897640228271428]]],[[[88.42546081542997,21.904090881347656],[88.4254684448245,21.903800964355582],[88.42512512207048,21.90360260009794],[88.42500305175787,21.903608322143498]]],[[[88.45,21.9],[88.46,21.79],[88.39,21.83],[88.45,21.9]]],[[[88.71805572509794,21.907222747802734],[88.71833038330078,21.906944274902344],[88.71861267089872,21.906944274902344],[88.71944427490251,21.906110763549805]]],[[[88.10694885253935,21.893600463867188],[88.10722`,
  `351074224,21.893333435058707],[88.10805511474638,21.893333435058707],[88.10861206054693,21.89277839660673]]],[[[88.5047225952149,21.912780761718864],[88.50499725341825,21.912509918212834],[88.50776672363287,21.912509918212834],[88.50805664062528,21.91222000122093]]],[[[88.4524536132813,21.906337738037166],[88.45197296142607,21.906080245971623],[88.45173645019537,21.905946731567496],[88.45094299316412,21.906129837036417]]],[[[88.6399993896485,21.921680450439396],[88.64026641845703,21.921390533447493],[88.64083862304688,21.921390533447493],[88.64111328125006,21.921110153198356]]],[[[88.13478851318388,21.926744461059684],[88.1350402832033,21.92642021179205],[88.1353149414063,21.926057815551758],[88.13553619384794,21.925621032714844]]],[[[88.84,21.92],[88.98,21.87],[88.89,21.81],[88.84,21.92]]],[[[88.72360992431635,21.931943893432674],[88.72416687011747,21.9313907623291],[88.72444152832037,21.9313907623291],[88.72444152832037,21.931110382080135]]],[[[88.16333007812506,21.937221527099837],[88.1636123657226,21.936943054199446],[88.16414642334013,21.936950683593807],[88.16443634033203,21.936679840087947]]],[[[88.7453918457033,21.97973823547369],[88.74587249755888,21.97972106933605],[88.74640655517584,21.97972106933605],[88.74698638916021,21.979692459106673]]],[[[88.75916290283209,21.998607635498047],[88.75916290283209,21.997222900390682],[88.75888824462885,21.996946334839095],[88.75888824462885,21.99666976928711]]],[[[88.6599731445313,22.019212722778377],[88.66049957275408,22.018890380859375],[88.66099548339872,22.018602371216048],[88.66144561767595,22.01832771301264]]],[[[88.14138793945318,22.02639007568382],[88.14250183105469,22.02527809143089],[88.1427764892581,22.02527809143089],[88.14332580566412,22.024719238281534]]],[[[88.81,22.02],[88.9,22.01],[88.91,21.93],[88.75,21.96],[88.81,22.02]]],[[[88.73143768310547,22.045246124267692],[88.7328491210938,22.043600082397404],[88.73339080810564,22.043600082397404],[88.73342132568365,22.043098449707202]]],[[[88.76380920410185,2`,
  `2.051670074463118],[88.76432037353521,22.05166053772001],[88.76480102539057,22.051670074463118],[88.76529693603521,22.051670074463118]]],[[[88.90278625488287,22.0453338623048],[88.90251159667963,22.044738769531534],[88.9022979736331,22.044141769409293],[88.9021377563476,22.043544769287053]]],[[[88.03138732910185,22.060560226440543],[88.03138732910185,22.059440612793082],[88.03111267089844,22.059164047241268],[88.03083038330107,22.059169769287223]]],[[[89.02,22.05],[89.06,21.93],[88.97,21.99],[89.02,22.05]]],[[[88.63582611084013,22.050819396972713],[88.63610839843767,22.050556182861612],[88.63610839843767,22.050279617309798],[88.63639068603544,22.050001144409407]]],[[[88.81185913085949,22.060754776001204],[88.81230163574213,22.060651779175032],[88.81276702880865,22.060770034790266],[88.81322479248075,22.06079292297369]]],[[[88.87055969238287,22.07893943786621],[88.87055206298834,22.07830238342308],[88.87049865722673,22.077709197998217],[88.87032318115251,22.07722282409668]]],[[[88.69005584716814,22.079984664917276],[88.68985748291016,22.079980850219727],[88.68950653076189,22.080312728881893],[88.6894760131836,22.080789566040096]]],[[[88.9040832519533,22.084207534790266],[88.90367126464844,22.083829879760856],[88.90328216552729,22.083440780639762],[88.90287017822294,22.083131790161417]]],[[[88.72230529785173,22.09913444519043],[88.72229003906267,22.098573684692667],[88.72144317626959,22.09778022766136],[88.72090911865263,22.097742080688477]]],[[[88.80346679687511,22.08527374267578],[88.80375671386736,22.08487129211437],[88.80408477783232,22.084524154663313],[88.80442810058622,22.084196090698356]]],[[[88.81790161132818,22.123029708862532],[88.81819915771513,22.12293434143089],[88.81846618652344,22.122941970825252],[88.8187866210937,22.12303924560547]]],[[[88.72927856445341,22.11362075805664],[88.7289428710937,22.11321830749506],[88.728500366211,22.11324119567888],[88.72807312011724,22.11326980590843]]],[[[88.87,22.17],[88.92,22.09],[88.83,22.13],[88.87,22.17]]],[[[88.9`,
  `5,22.19],[88.92,22.02],[88.96,22.06],[89.01,21.9],[88.91,21.99],[88.89,22.17],[88.95,22.19]]],[[[89.0,22.2],[89.05,22.13],[88.98,22.04],[89.0,22.2]]],[[[88.7,22.21],[88.79,22.17],[88.68,22.08],[88.72,22.01],[88.63,22.11],[88.7,22.21]]],[[[88.84474945068376,22.189191818237305],[88.84516906738281,22.18914985656744],[88.8455657958985,22.18914985656744],[88.84595489501959,22.18916893005371]]],[[[87.9897232055664,22.217500686645508],[87.99028015136736,22.21694183349632],[87.99055480957043,22.216943740844727],[87.99083709716814,22.21666717529314]]],[[[88.93237304687506,22.225000381469954],[88.93305206298845,22.224805831909123],[88.93377685546903,22.224912643432674],[88.93447875976568,22.224760055542106]]],[[[88.81,22.28],[88.83,22.17],[88.75,22.2],[88.81,22.28]]],[[[88.85,22.36],[88.94,22.3],[88.91,22.22],[88.84,22.29],[88.92,22.17],[88.88,22.25],[88.88,22.2],[88.8,22.23],[88.85,22.36]]],[[[88.98,22.38],[89.06,22.13],[88.95,22.26],[88.98,22.38]]],[[[87.93805694580084,22.39666938781744],[87.93776702880888,22.39666938781744],[87.9375,22.396949768066406],[87.9375,22.397499084472656]]],[[[88.8619461059572,22.3988876342774],[88.86305236816423,22.397779464721793],[88.86332702636724,22.398061752319563],[88.86361694335938,22.398061752319563]]],[[[88.86777496337919,22.41083335876465],[88.86805725097656,22.410554885864485],[88.86888885498058,22.410554885864485],[88.8694458007813,22.410001754760685]]],[[[88.9188995361331,22.426532745361442],[88.91889190673857,22.425279617309627],[88.91860961914068,22.425001144409237],[88.91860961914068,22.424722671508846]]],[[[87.92568206787115,22.424829483032227],[87.9253921508789,22.424694061279297],[87.92395782470709,22.425619125366325],[87.922660827637,22.426570892334155]]],[[[87.91194152832037,22.432220458984375],[87.91194152832037,22.43194389343256],[87.91278076171903,22.431110382080192],[87.91306304931646,22.43139076232916]]],[[[88.85916900634794,22.46944427490257],[88.85916900634794,22.46666908264166],[88.85888671875017,22.466390609741268],[`,
  `88.85888671875017,22.463609695434798]]],[[[88.78138732910185,22.500562667846793],[88.7819366455081,22.500001907348633],[88.78277587890642,22.500001907348633],[88.78305816650402,22.500280380249023]]],[[[88.9,22.55],[88.9,22.37],[88.84,22.51],[88.9,22.55]]],[[[88.93419647216814,22.564031600952376],[88.93483734130865,22.563888549804915],[88.93553924560564,22.56369972229004],[88.93596649169928,22.56343269348156]]],[[[88.92,22.57],[89.0,22.43],[88.94,22.31],[88.92,22.57]]],[[[88.93605041503935,22.62157058715826],[88.93650817871111,22.61913681030302],[88.93535614013689,22.61982154846214],[88.93486022949224,22.620691299438647]]],[[[88.67597198486345,24.315500259399528],[88.67481994628923,24.314569473266715],[88.67510223388683,24.315378189086914],[88.67597198486345,24.315500259399528]]],[[[88.13,27.12],[88.43,27.08],[88.59,27.19],[88.8,27.14],[88.87,27.11],[88.87,26.95],[89.02,26.94],[89.13,26.81],[89.38,26.87],[89.64,26.78],[89.63,26.72],[89.86,26.7],[89.87,26.45],[89.72,26.3],[89.73,26.17],[89.64,26.23],[89.6,26.1],[89.65,26.06],[89.55,25.96],[89.17,26.13],[89.09,26.4],[88.96,26.46],[88.92,26.37],[89.07,26.26],[88.89,26.29],[88.85,26.23],[88.62,26.47],[88.44,26.55],[88.42,26.63],[88.38,26.59],[88.33,26.48],[88.48,26.46],[88.52,26.36],[88.18,26.15],[88.19,26.02],[88.09,25.91],[88.12,25.8],[88.27,25.81],[88.54,25.51],[88.81,25.52],[88.84,25.36],[89.01,25.29],[88.92,25.17],[88.45,25.2],[88.4,24.95],[88.33,24.87],[88.23,24.96],[88.14,24.94],[88.18,24.86],[88.01,24.67],[88.33,24.38],[88.73,24.28],[88.69,24.11],[88.77,23.98],[88.58,23.86],[88.56,23.64],[88.8,23.49],[88.72,23.25],[88.99,23.21],[88.85,23.0],[88.97,22.84],[88.95,22.66],[88.81,22.73],[88.96,22.61],[88.85,22.43],[88.68,22.59],[88.88,22.36],[88.73,22.2],[88.64,22.22],[88.67,22.34],[88.62,22.11],[88.57,22.19],[88.61,21.91],[88.55,21.97],[88.57,21.9],[88.49,21.88],[88.55,22.04],[88.47,21.9],[88.46,22.01],[88.41,21.89],[88.38,21.97],[88.39,21.8],[88.36,21.92],[88.35,21.86],[88.27,21.88],[88.27,21.73],[88.16,21.88],[88.2`,
  `,22.17],[88.07,22.21],[88.11,22.3],[88.05,22.22],[87.98,22.25],[87.88,22.44],[87.94,22.26],[88.19,22.1],[88.06,22.01],[87.96,22.1],[88.05,22.01],[87.93,21.8],[87.48,21.61],[87.44,21.76],[87.26,21.81],[87.23,21.95],[87.03,21.87],[87.02,22.04],[86.72,22.14],[86.89,22.29],[86.76,22.43],[86.76,22.57],[86.65,22.58],[86.62,22.67],[86.42,22.78],[86.43,22.92],[86.54,22.99],[86.21,22.99],[86.04,23.14],[85.91,23.13],[85.83,23.26],[85.87,23.47],[86.05,23.49],[86.04,23.58],[86.3,23.42],[86.44,23.63],[86.79,23.69],[86.79,23.83],[87.24,23.83],[87.29,23.9],[87.24,24.04],[87.46,23.98],[87.49,24.12],[87.69,24.15],[87.64,24.24],[87.81,24.41],[87.77,24.58],[87.91,24.59],[87.9,24.72],[87.82,24.77],[87.97,24.9],[87.77,25.1],[87.86,25.28],[87.76,25.41],[87.92,25.54],[88.07,25.5],[88.05,25.69],[87.8,25.92],[87.84,26.04],[88.29,26.35],[88.18,26.49],[88.23,26.55],[88.11,26.54],[88.19,26.77],[88.14,26.99],[87.99,27.11],[88.02,27.22],[88.13,27.12]]]]}}]}`,
];
const INDIA_GEO = JSON.parse(_GP.join(""));

const _IP=[
  `[{"n":"Andaman and Nicobar","d":"M516.4,424.4 L516.4,424.4 L516.4,424.4 L516.4,424.4Z M515.1,419.6 L515.1,419.6 L515.0,419.6 L515.0,419.6Z M517.6,419.2 L519.6,422.4 L517.2,425.7 L513.9,420.7 L517.6,419.2Z M517.6,418.5 L517.6,418.5 L517.6,418.5 L517.6,418.6Z M514.0,417.3 L514.0,417.3 L514.0,417.3 L514.0,417.3Z M516.0,417.0 L516.1,417.1 L516.1,417.1 L516.1,417.1Z M514.5,416.9 L514.5,416.9 L514.5,416.9 L514.5,416.9Z M514.9,416.5 L515.9,417.6 L513.7,419.2 L513.3,417.5 L514.9,416.5Z M513.6,416.0 L513.6,416.0 L513.7,416.0 L513.7,416.0Z M513.4,416.0 L513.4,416.0 L513.4,416.0 L513.4,416.0Z M511.6,415.4 L511.6,415.4 L511.6,415.4 L511.7,415.4Z M507.6,410.3 L507.6,410.3 L507.6,410.3 L507.6,410.3Z M507.6,410.2 L507.6,410.2 L507.6,410.2 L507.6,410.3Z M508.4,408.8 L509.9,410.8 L507.2,410.0 L508.4,408.8Z M511.7,408.6 L512.3,410.0 L510.9,409.3 L511.7,408.6Z M512.3,407.4 L512.3,407.4 L512.3,407.4 L512.3,407.4Z M511.3,406.0 L510.7,409.0 L509.7,406.8 L511.3,406.0Z M505.5,405.5 L505.5,405.5 L505.5,405.5 L505.6,405.5Z M503.4,404.2 L504.8,406.5 L502.6,405.4 L503.4,404.2Z M513.7,403.8 L513.7,403.8 L513.7,403.8 L513.7,403.8Z M513.4,403.8 L513.4,403.8 L513.4,403.8 L513.4,403.8Z M501.7,402.7 L501.7,402.7 L501.7,402.7 L501.8,402.7Z M512.9,402.6 L512.9,402.6 L512.9,402.6 L512.9,402.6Z M513.0,401.4 L513.0,401.4 L513.1,401.4 L513.1,401.4Z M512.9,401.3 L512.9,401.3 L512.9,401.3 L512.9,401.3Z M498.1,398.1 L498.1,398.1 L498.1,398.1 L498.1,398.1Z M496.8,394.1 L496.8,394.1 L496.8,394.1 L496.8,394.1Z M497.0,394.0 L497.0,394.1 L497.0,394.1 L497.0,394.1Z M497.2,394.0 L497.2,394.0 L497.2,394.0 L497.2,394.0Z M496.7,392.4 L497.5,393.8 L495.5,394.1 L496.7,392.4Z M491.4,370.1 L492.8,371.6 L492.4,374.4 L491.2,375.4 L488.8,375.1 L488.6,371.7 L491.4,370.1Z M493.2,369.6 L493.2,369.6 L493.2,369.6 L493.2,369.6Z M485.6`,
  `,369.0 L485.6,369.0 L485.6,369.0 L485.7,369.0Z M494.2,369.0 L494.2,369.0 L494.2,369.0 L494.2,369.0Z M495.5,366.8 L495.5,366.8 L495.5,366.8 L495.5,366.8Z M495.6,366.8 L495.6,366.8 L495.6,366.8 L495.6,366.8Z M494.5,366.3 L494.5,366.3 L494.5,366.3 L494.5,366.3Z M495.1,364.9 L495.1,364.9 L495.1,364.9 L495.1,364.9Z M495.0,364.6 L495.0,364.6 L495.0,364.6 L495.0,364.6Z M495.4,364.5 L495.4,364.5 L495.4,364.5 L495.4,364.5Z M492.0,363.5 L492.0,363.5 L492.0,363.5 L491.9,363.5Z M492.1,363.5 L492.1,363.5 L492.1,363.5 L492.1,363.5Z M494.4,362.2 L494.4,362.2 L494.4,362.2 L494.4,362.2Z M493.2,362.0 L493.2,362.0 L493.2,362.0 L493.2,362.0Z M493.9,361.8 L493.9,361.8 L493.8,361.8 L493.8,361.8Z M493.8,361.9 L494.8,363.8 L493.0,364.1 L493.8,361.9Z M486.5,361.8 L486.5,361.8 L486.5,361.8 L486.5,361.8Z M493.1,361.6 L493.1,361.6 L493.1,361.6 L493.1,361.6Z M492.2,361.5 L492.2,361.5 L492.2,361.5 L492.2,361.5Z M493.5,361.5 L493.5,361.5 L493.5,361.4 L493.5,361.4Z M493.2,361.2 L493.2,361.2 L493.2,361.2 L493.2,361.2Z M492.5,361.2 L492.5,361.2 L492.5,361.2 L492.5,361.2Z M492.3,361.1 L492.3,361.1 L492.3,361.1 L492.3,361.1Z M492.9,361.5 L492.9,361.5 L492.9,361.5 L492.9,361.5Z M492.6,360.9 L492.6,360.9 L492.5,360.9 L492.5,360.9Z M493.2,360.8 L493.2,360.8 L493.2,360.8 L493.2,360.8Z M485.5,360.8 L485.5,360.8 L485.5,360.8 L485.5,360.8Z M491.8,360.6 L491.8,360.6 L491.8,360.6 L491.8,360.6Z M494.9,359.8 L495.0,359.8 L495.0,359.8 L495.0,359.8Z M496.2,359.7 L496.2,359.7 L496.2,359.7 L496.2,359.7Z M495.4,359.5 L495.5,359.5 L495.5,359.5 L495.5,359.5Z M492.0,359.0 L492.0,359.0 L492.0,359.0 L492.0,359.0Z M502.5,358.2 L502.5,358.3 L502.5,358.3 L502.5,358.3Z M501.3,357.4 L501.3,357.4 L501.3,357.4 L501.3,357.4Z M492.9,356.5 L492.9,356.5 L492.9,356.5 L492.9,356.5Z M492.3,355.9 L492.3,355.9 L492.3,355.9 L492.3,355.9Z M495`,
  `.6,355.9 L495.6,355.9 L495.6,355.9 L495.6,355.9Z M495.8,355.7 L495.8,355.7 L495.8,355.7 L495.8,355.7Z M495.9,355.7 L496.0,355.7 L496.0,355.7 L496.0,355.7Z M492.9,355.6 L492.9,355.6 L492.9,355.6 L492.9,355.6Z M492.6,355.6 L492.6,355.6 L492.6,355.6 L492.6,355.6Z M496.5,355.0 L496.5,355.0 L496.5,355.0 L496.5,355.0Z M500.3,354.9 L501.7,356.9 L499.5,355.3 L500.3,354.9Z M500.3,354.4 L500.3,354.4 L500.3,354.4 L500.3,354.4Z M500.7,353.8 L500.7,353.8 L500.7,353.8 L500.7,353.8Z M500.8,353.8 L500.7,353.8 L500.7,353.8 L500.7,353.8Z M495.8,353.7 L495.8,353.7 L495.8,353.7 L495.8,353.7Z M499.9,353.7 L499.9,353.7 L499.9,353.7 L499.9,353.7Z M493.6,353.7 L493.5,353.7 L493.5,353.7 L493.5,353.7Z M493.6,353.7 L493.6,353.7 L493.6,353.7 L493.6,353.7Z M502.8,353.4 L502.8,353.4 L502.8,353.4 L502.8,353.4Z M503.2,353.3 L503.2,353.3 L503.2,353.3 L503.2,353.3Z M497.8,353.3 L497.8,353.3 L497.8,353.3 L497.8,353.3Z M501.5,353.1 L501.9,354.6 L500.1,353.4 L501.5,353.1Z M496.1,352.8 L496.1,352.8 L496.2,352.8 L496.2,352.8Z M495.4,352.8 L495.4,352.8 L495.3,352.8 L495.3,352.8Z M495.6,352.7 L495.6,352.7 L495.6,352.7 L495.6,352.7Z M502.2,352.4 L502.3,352.4 L502.3,352.4 L502.3,352.4Z M494.6,352.4 L494.6,352.4 L494.6,352.4 L494.6,352.4Z M501.3,352.2 L501.3,352.2 L501.3,352.2 L501.3,352.2Z M499.7,352.2 L499.7,352.2 L499.7,352.2 L499.7,352.3Z M495.0,352.0 L496.5,354.6 L494.6,357.7 L496.7,356.6 L496.1,359.3 L494.4,360.0 L496.1,359.7 L495.2,362.3 L491.2,357.3 L492.2,355.9 L493.2,357.0 L495.0,352.0Z M495.6,352.0 L495.6,352.0 L495.6,352.0 L495.6,352.0Z M498.5,351.9 L498.5,351.9 L498.5,351.9 L498.5,351.9Z M498.2,352.1 L498.2,352.1 L498.2,352.1 L498.2,352.1Z M494.9,351.9 L494.9,352.0 L494.9,351.9 L494.9,351.9Z M498.9,351.8 L498.9,351.8 L498.9,351.8 L498.9,351.8Z M502.4,351.7 L502.4,351.7 L502.4,351.7 L502.4,351.7Z M498`,
  `.9,351.7 L498.9,351.8 L498.9,351.8 L498.9,351.8Z M495.7,351.6 L495.7,351.6 L495.7,351.6 L495.7,351.6Z M501.5,351.5 L501.5,351.5 L501.5,351.5 L501.5,351.5Z M495.9,351.4 L495.9,351.4 L495.9,351.4 L495.9,351.4Z M495.7,351.4 L495.7,351.4 L495.7,351.4 L495.7,351.4Z M496.3,351.6 L496.3,351.6 L496.3,351.6 L496.3,351.6Z M496.0,351.3 L496.0,351.3 L496.0,351.3 L496.0,351.3Z M496.4,351.3 L496.4,351.3 L496.4,351.3 L496.4,351.3Z M498.5,351.3 L498.5,351.3 L498.5,351.3 L498.4,351.3Z M495.2,351.3 L495.2,351.3 L495.2,351.3 L495.2,351.3Z M496.3,351.2 L496.3,351.2 L496.3,351.2 L496.3,351.2Z M499.7,351.5 L499.7,351.5 L499.7,351.5 L499.7,351.5Z M496.5,351.1 L498.7,351.6 L496.1,354.5 L496.5,351.1Z M502.3,350.9 L502.3,351.0 L502.3,351.0 L502.3,351.0Z M517.4,350.9 L517.8,351.3 L517.8,351.3 L517.9,351.3Z M499.2,350.8 L499.1,350.8 L499.1,350.8 L499.1,350.8Z M499.0,350.7 L499.0,350.7 L499.0,350.7 L499.0,350.7Z M499.1,350.7 L499.1,350.7 L499.1,350.7 L499.1,350.7Z M498.8,350.0 L498.8,350.0 L498.8,350.0 L498.8,350.0Z M498.0,349.7 L498.0,349.7 L498.0,349.7 L498.0,349.7Z M498.9,349.7 L498.9,349.7 L498.9,349.7 L498.9,349.7Z M498.7,349.7 L498.7,349.7 L498.7,349.7 L498.7,349.7Z M498.2,349.6 L498.2,349.6 L498.3,349.6 L498.3,349.6Z M499.0,349.6 L499.0,349.6 L498.9,349.6 L498.9,349.6Z M497.6,349.5 L497.6,349.5 L497.6,349.5 L497.6,349.5Z M500.0,349.6 L500.0,349.7 L500.0,349.7 L500.0,349.7Z M498.4,349.2 L498.4,349.2 L498.4,349.2 L498.4,349.2Z M494.6,347.9 L494.6,347.9 L494.6,347.9 L494.6,347.9Z M495.0,346.6 L495.0,346.6 L495.0,346.6 L495.0,346.6Z M495.6,345.7 L495.6,345.7 L495.6,345.7 L495.6,345.7Z M495.4,345.3 L495.4,345.3 L495.5,345.3 L495.5,345.3Z M495.5,345.1 L495.5,345.1 L495.5,345.1 L495.5,345.1Z M494.1,344.8 L494.1,344.8 L494.1,344.8 L494.1,344.8Z M495.3,344.8 L495.3,344.8 L495.3,344.8 L495.3,344.8Z M4`,
  `95.4,344.9 L495.4,344.9 L495.4,344.9 L495.4,344.9Z M495.3,344.5 L495.3,344.5 L495.3,344.5 L495.3,344.5Z M495.3,344.4 L495.3,344.4 L495.3,344.4 L495.3,344.4Z M495.3,344.4 L495.3,344.4 L495.3,344.4 L495.3,344.4Z M495.2,344.0 L495.2,344.0 L495.2,344.0 L495.2,344.0Z M495.5,343.9 L495.5,343.9 L495.5,343.9 L495.5,343.9Z M495.6,343.7 L495.6,343.7 L495.6,343.7 L495.6,343.7Z M495.5,343.5 L495.5,343.6 L495.5,343.6 L495.5,343.6Z M496.5,343.5 L496.5,343.5 L496.5,343.5 L496.5,343.5Z M496.2,343.7 L496.2,343.7 L496.2,343.7 L496.2,343.7Z M496.1,343.4 L496.1,343.4 L496.1,343.4 L496.1,343.4Z M496.6,343.2 L496.6,343.2 L496.7,343.2 L496.7,343.2Z M498.8,343.1 L498.8,343.1 L498.8,343.1 L498.8,343.1Z M496.0,342.9 L496.0,342.9 L496.0,342.9 L496.0,342.9Z M498.2,342.9 L498.2,342.9 L498.2,342.9 L498.2,342.9Z M496.8,342.9 L496.8,342.9 L496.8,342.9 L496.8,342.9Z M499.2,342.8 L499.1,342.8 L499.1,342.9 L499.1,342.9Z M496.3,342.8 L496.3,342.8 L496.3,342.8 L496.3,342.8Z M499.6,342.8 L499.6,342.8 L499.6,342.8 L499.6,342.8Z M496.3,342.7 L496.3,342.7 L496.3,342.7 L496.3,342.7Z M498.9,342.8 L500.3,348.5 L499.1,349.7 L496.7,348.9 L498.9,350.9 L495.4,351.2 L494.6,347.0 L496.7,346.2 L495.5,346.2 L495.4,344.0 L498.9,342.8Z M496.4,342.6 L496.4,342.6 L496.4,342.6 L496.4,342.7Z M498.4,342.6 L498.5,342.6 L498.5,342.6 L498.5,342.6Z M496.3,342.6 L496.3,342.6 L496.3,342.6 L496.3,342.7Z M498.8,342.6 L498.8,342.6 L498.7,342.6 L498.7,342.6Z M498.9,342.5 L498.9,342.5 L498.9,342.5 L498.9,342.5Z M494.4,342.4 L494.4,342.4 L494.4,342.4 L494.4,342.4Z M494.3,342.3 L494.3,342.3 L494.4,342.3 L494.4,342.3Z M495.0,341.8 L494.4,344.7 L493.6,343.3 L495.0,341.8Z M501.0,341.7 L501.0,341.8 L501.0,341.8 L501.0,341.8Z M500.6,341.7 L500.6,341.7 L500.6,341.7 L500.6,341.7Z M499.1,341.7 L499.1,341.7 L499.1,341.7 L499.1,341.7Z M499.9,341.4 L4`,
  `99.9,341.4 L499.9,341.4 L499.8,341.4Z M499.4,341.4 L499.4,341.4 L499.4,341.4 L499.4,341.4Z M499.3,341.2 L499.2,341.2 L499.2,341.1 L499.2,341.1Z M499.6,341.0 L499.6,341.0 L499.6,341.0 L499.5,341.0Z M499.2,340.9 L499.2,340.9 L499.2,340.9 L499.2,340.9Z M495.6,340.4 L495.6,340.4 L495.6,340.4 L495.6,340.4Z M495.3,340.4 L495.4,340.4 L495.4,340.4 L495.4,340.4Z M496.8,339.4 L496.8,339.4 L496.8,339.4 L496.9,339.4Z M502.1,338.7 L502.1,338.7 L502.1,338.7 L502.0,338.7Z M501.2,337.8 L501.2,337.9 L501.2,337.9 L501.2,337.9Z M502.3,337.6 L502.3,337.6 L502.4,337.6 L502.4,337.6Z M501.2,337.2 L501.2,337.2 L501.2,337.2 L501.2,337.2Z M500.2,337.2 L500.2,337.2 L500.2,337.2 L500.2,337.2Z M501.2,337.1 L501.2,337.1 L501.2,337.1 L501.2,337.1Z M501.6,337.1 L501.6,337.1 L501.6,337.1 L501.6,337.1Z M502.4,336.7 L502.4,336.7 L502.4,336.7 L502.4,336.7Z M502.5,336.7 L502.5,336.7 L502.5,336.7 L502.5,336.7Z M502.1,336.5 L502.1,336.5 L502.1,336.5 L502.1,336.5Z M498.2,336.1 L498.2,336.1 L498.2,336.1 L498.2,336.1Z M497.2,336.0 L497.2,336.0 L497.2,336.0 L497.2,336.0Z M502.7,336.0 L502.7,336.0 L502.7,336.0 L502.7,336.0Z M502.3,335.9 L502.3,335.9 L502.3,335.9 L502.3,335.9Z M502.8,335.8 L502.8,335.8 L502.9,335.8 L502.9,335.8Z M497.8,335.7 L497.8,335.7 L497.8,335.7 L497.8,335.7Z M526.0,335.4 L526.0,335.4 L526.0,335.4 L526.0,335.4Z M498.4,334.7 L498.4,334.7 L498.4,334.8 L498.4,334.8Z M499.3,334.7 L499.3,334.7 L499.3,334.7 L499.3,334.7Z M499.1,334.4 L499.1,334.4 L499.1,334.4 L499.1,334.4Z M498.4,334.3 L498.4,334.4 L498.4,334.4 L498.5,334.4Z M501.0,334.1 L501.0,334.2 L501.0,334.2 L501.0,334.2Z M502.0,334.0 L502.0,334.0 L502.0,334.0 L502.0,334.0Z M501.5,334.0 L501.5,336.7 L502.6,337.1 L499.9,337.1 L502.3,338.0 L501.5,340.6 L500.3,341.6 L498.7,340.9 L499.7,342.1 L497.7,343.3 L496.7,341.4 L497.7,336.3 L501.5,334.0Z M4`,
  `98.8,333.5 L498.8,333.5 L498.9,333.5 L498.9,333.5Z M502.1,332.8 L502.1,332.8 L502.2,332.8 L502.2,332.8Z M501.3,332.6 L501.3,332.6 L501.3,332.6 L501.3,332.6Z M501.2,332.5 L501.2,332.5 L501.2,332.5 L501.2,332.5Z M505.3,327.9 L505.3,327.9 L505.3,327.9 L505.3,327.9Z M508.1,327.4 L508.1,327.4 L508.1,327.5 L508.1,327.5Z M508.4,326.3 L508.4,326.4 L508.4,326.4 L508.4,326.4Z M508.1,326.0 L508.1,326.0 L508.1,326.0 L508.1,326.0Z M507.9,325.5 L507.9,325.5 L507.9,325.5 L507.9,325.5Z M508.2,325.4 L508.2,325.5 L508.2,325.5 L508.2,325.5Z M511.7,317.4 L511.7,317.4 L511.7,317.4 L511.7,317.4Z M512.1,316.5 L512.1,316.5 L512.1,316.5 L512.1,316.5Z M512.2,316.3 L512.1,316.3 L512.1,316.3 L512.1,316.3Z M512.2,316.2 L512.2,316.2 L512.2,316.2 L512.2,316.2Z M513.5,315.8 L513.5,315.8 L513.5,315.8 L513.5,315.8Z M513.7,315.3 L513.7,315.3 L513.7,315.3 L513.7,315.3Z","cx":499.7,"cy":356.0},{"n":"Andhra Pradesh","d":"M250.0,335.5 L250.0,335.5 L250.0,335.5 L250.0,335.5Z M249.1,335.0 L249.1,335.0 L249.1,335.0 L249.1,335.0Z M249.2,335.0 L249.2,335.0 L249.2,335.0 L249.2,335.0Z M249.8,334.6 L249.8,334.6 L249.8,334.6 L249.8,334.6Z M248.4,334.6 L248.4,334.6 L248.4,334.6 L248.4,334.6Z M248.3,334.4 L248.3,334.4 L248.3,334.4 L248.3,334.4Z M245.7,333.7 L245.7,333.7 L245.7,333.7 L245.7,333.7Z M247.5,333.3 L247.5,333.3 L247.6,333.3 L247.6,333.3Z M246.5,333.0 L246.5,333.0 L246.5,333.0 L246.5,333.0Z M246.7,332.8 L246.7,332.8 L246.7,332.8 L246.7,332.8Z M246.6,332.5 L246.6,332.5 L246.7,332.5 L246.7,332.5Z M245.8,311.7 L245.8,311.7 L245.8,311.7 L245.8,311.7Z M248.8,307.5 L248.8,307.5 L248.8,307.5 L248.8,307.5Z M264.9,303.9 L264.9,303.9 L264.9,303.9 L264.9,303.9Z M260.0,302.9 L260.0,302.9 L260.0,302.9 L260.0,302.9Z M260.1,302.8 L260.1,302.8 L260.2,302.8 L260.2,302.8Z M260.1,302.7 L260.1,302.7 L260.1,302.7 L260.1,302.7Z M2`,
  `59.9,302.6 L259.9,302.6 L259.9,302.6 L259.9,302.6Z M275.0,295.8 L275.0,295.8 L275.0,295.8 L275.0,295.8Z M274.9,295.8 L274.9,295.8 L274.9,295.8 L274.9,295.8Z M290.3,292.7 L290.3,292.8 L290.3,292.8 L290.3,292.8Z M289.2,291.3 L289.2,291.3 L289.2,291.3 L289.2,291.3Z M289.9,290.8 L289.9,290.8 L289.9,290.8 L289.9,290.8Z M290.1,290.8 L290.1,290.8 L290.1,290.8 L290.1,290.8Z M290.2,290.7 L290.2,290.7 L290.2,290.7 L290.2,290.7Z M290.6,290.7 L290.6,290.7 L290.6,290.7 L290.6,290.7Z M290.5,290.7 L290.1,292.4 L289.2,291.2 L290.5,290.7Z M307.1,279.0 L307.1,279.0 L307.1,279.0 L307.1,279.0Z M309.8,277.4 L309.8,277.4 L309.8,277.4 L309.8,277.4Z M309.9,277.4 L309.9,277.4 L309.9,277.4 L309.9,277.4Z M309.1,277.0 L309.1,277.0 L309.0,277.0 L309.0,277.0Z M289.9,290.9 L287.4,290.6 L290.1,292.8 L282.9,295.2 L278.5,296.4 L271.6,295.7 L263.7,304.4 L260.8,304.7 L260.6,302.9 L258.2,302.3 L249.9,305.2 L246.2,310.0 L245.6,313.3 L245.8,316.9 L248.6,320.0 L247.0,326.6 L250.9,335.9 L247.6,331.9 L247.4,333.4 L246.8,332.0 L245.6,333.7 L250.7,336.7 L249.1,335.2 L244.8,334.5 L243.2,337.1 L239.1,338.0 L239.5,339.1 L238.1,337.9 L236.3,338.3 L233.4,337.4 L232.2,337.6 L233.2,339.1 L231.0,340.3 L229.2,339.8 L227.9,341.6 L224.5,340.6 L223.3,341.4 L222.5,340.5 L219.0,340.9 L217.2,342.0 L216.0,345.9 L214.6,345.4 L214.1,347.0 L212.5,347.0 L208.9,346.0 L209.9,343.7 L212.1,342.7 L214.1,343.7 L213.5,342.1 L216.6,338.2 L212.5,337.4 L212.9,333.8 L208.7,334.1 L208.3,332.9 L206.8,333.0 L207.4,330.1 L204.0,330.5 L204.8,328.8 L201.6,329.0 L199.5,331.8 L198.3,331.1 L194.3,332.5 L193.7,330.3 L189.0,330.0 L189.0,329.2 L188.8,331.5 L185.3,331.6 L186.3,329.0 L183.3,325.9 L185.9,325.8 L185.9,327.4 L188.4,328.2 L191.6,327.8 L193.4,329.7 L193.9,328.5 L192.0,327.8 L193.4,326.7 L192.4,326.5 L195.3,326.0 L195.3,324.5 L193.2,323.7 L193.0,`,
  `325.5 L191.0,323.6 L188.4,323.4 L187.6,325.2 L184.3,324.8 L183.1,322.8 L184.9,321.5 L182.9,321.7 L180.7,319.9 L182.9,315.2 L180.7,314.8 L180.9,313.6 L187.0,314.4 L188.4,312.8 L188.6,310.8 L184.9,307.7 L186.1,305.8 L187.8,305.6 L185.9,303.0 L186.9,302.1 L195.5,301.8 L195.1,297.2 L197.1,296.0 L190.2,294.2 L194.5,292.7 L193.7,291.6 L195.3,286.7 L193.0,283.8 L195.5,280.9 L199.1,280.1 L194.1,278.8 L198.3,273.4 L196.3,272.3 L197.3,269.1 L195.9,266.9 L197.3,265.3 L200.1,265.3 L202.0,261.7 L204.0,261.5 L200.5,258.6 L202.2,257.8 L202.4,254.8 L204.2,254.3 L208.5,255.7 L208.7,253.3 L211.3,252.6 L210.5,249.8 L212.5,248.1 L211.3,246.2 L214.8,247.9 L221.9,248.4 L222.1,249.8 L224.3,249.9 L223.9,251.3 L228.4,252.6 L229.6,250.5 L234.2,252.0 L240.9,251.0 L244.0,253.4 L243.4,256.6 L241.8,257.6 L243.2,258.7 L242.8,261.7 L246.8,263.5 L249.9,262.9 L251.3,264.8 L254.1,264.2 L257.0,265.7 L260.2,269.5 L259.0,270.6 L261.0,269.8 L261.6,271.2 L263.7,270.6 L265.3,276.0 L267.5,275.1 L276.3,275.5 L284.4,272.2 L289.2,273.3 L291.1,271.2 L290.1,270.2 L291.7,268.7 L290.5,268.5 L291.1,267.3 L293.3,265.5 L296.5,269.8 L299.8,266.9 L301.8,268.0 L304.7,267.7 L304.1,266.9 L305.5,265.5 L303.9,264.1 L306.3,262.2 L307.9,262.9 L311.6,261.4 L309.9,259.2 L312.8,259.7 L312.8,258.0 L314.2,258.9 L316.0,256.9 L318.5,260.1 L319.3,258.9 L320.9,261.5 L325.0,262.7 L329.6,262.1 L331.9,260.3 L331.7,258.9 L334.7,258.0 L335.1,258.9 L336.5,258.0 L335.1,257.3 L337.5,256.9 L338.2,258.3 L325.8,268.7 L315.0,272.7 L307.9,278.7 L291.3,285.2 L289.0,287.8 L290.9,288.9 L291.1,287.4 L289.9,290.9Z","cx":250.0,"cy":300.8},{"n":"Arunachal Pradesh","d":"M563.2,108.1 L564.7,110.2 L567.7,109.9 L562.2,112.6 L563.4,115.2 L570.5,112.6 L569.5,114.0 L572.2,117.2 L565.1,122.8 L567.9,123.8 L573.0,121.9 L579.7,124.1 L581.5,123.4 L587.6,125.9 L585.8,127`,
  `.7 L588.0,128.6 L587.4,130.4 L584.8,130.3 L577.7,134.6 L577.9,137.0 L582.7,142.4 L577.2,140.9 L575.8,138.6 L572.2,138.3 L570.3,139.5 L562.0,140.4 L554.7,145.5 L550.7,146.4 L548.6,148.3 L545.0,148.4 L544.2,143.2 L549.4,141.8 L550.5,139.8 L557.8,140.0 L560.4,138.3 L557.1,137.4 L557.6,135.6 L555.3,133.0 L559.6,129.4 L552.3,129.5 L529.7,135.5 L525.5,134.3 L525.7,136.1 L516.8,141.6 L517.4,142.8 L510.5,144.7 L501.3,145.0 L494.2,143.2 L492.8,144.4 L483.3,145.5 L481.6,141.5 L481.9,139.8 L483.5,139.5 L481.6,136.7 L474.3,136.7 L472.5,135.2 L474.1,132.5 L472.3,131.0 L477.6,131.8 L479.6,133.1 L485.3,131.0 L487.5,132.2 L492.2,131.6 L495.7,129.1 L494.8,127.0 L505.2,124.0 L504.4,122.3 L507.6,119.3 L519.2,118.8 L524.7,112.6 L531.6,110.4 L533.0,108.5 L536.4,111.4 L548.4,113.4 L551.1,111.9 L550.9,110.7 L555.7,108.4 L561.6,106.9 L563.2,108.1Z","cx":537.9,"cy":129.6},{"n":"Assam","d":"M439.2,165.4 L439.2,165.4 L439.3,165.6 L439.2,165.7Z M439.2,165.4 L439.2,165.4 L439.2,165.4 L439.2,165.4Z M559.0,129.8 L555.3,133.0 L557.6,135.6 L557.1,137.4 L560.4,138.3 L557.8,140.0 L550.3,139.8 L549.4,141.8 L540.7,144.9 L538.1,144.7 L535.6,147.3 L529.8,148.7 L526.9,151.8 L526.1,150.4 L520.6,156.1 L520.2,159.8 L516.6,161.4 L516.0,159.1 L507.4,165.2 L509.9,167.0 L510.1,168.8 L505.8,173.0 L504.8,176.1 L503.0,176.1 L501.7,181.9 L497.5,182.3 L496.3,180.3 L490.4,185.8 L489.4,184.2 L485.3,184.2 L487.1,177.1 L485.9,174.8 L490.8,175.2 L489.4,173.3 L490.6,171.7 L496.9,170.1 L496.5,168.5 L492.4,166.4 L494.0,164.7 L492.4,165.1 L488.8,162.3 L484.3,163.5 L485.7,160.0 L484.3,159.5 L487.1,157.5 L479.6,158.6 L477.6,156.9 L474.7,160.0 L472.9,158.2 L470.7,160.5 L471.9,160.5 L468.0,161.0 L465.8,162.8 L465.4,160.7 L461.4,161.3 L462.0,160.3 L460.3,159.4 L454.0,160.1 L453.2,159.2 L451.8,160.1 L451.2,158.3 L444.1,159.2 L439.6,162`,
  `.5 L442.1,164.5 L439.2,165.4 L438.0,161.3 L439.6,159.5 L435.6,155.8 L436.2,154.1 L439.0,153.0 L439.0,147.7 L444.3,147.5 L445.9,146.1 L449.8,145.3 L455.5,147.3 L475.0,146.7 L478.4,145.2 L482.3,146.1 L492.8,144.4 L494.2,143.2 L501.3,145.0 L513.9,144.3 L525.7,136.1 L525.5,134.3 L529.7,135.5 L552.3,129.5 L559.0,129.8Z","cx":487.8,"cy":157.7},{"n":"Bihar","d":"M404.4,150.7 L404.4,150.7 L404.4,150.7 L404.3,150.7Z M325.8,136.2 L329.4,138.2 L335.7,138.8 L337.1,140.7 L336.1,143.1 L342.4,144.4 L343.6,145.9 L347.1,145.8 L347.3,147.4 L355.8,145.8 L359.9,150.2 L363.5,148.7 L369.4,149.5 L377.3,152.4 L384.0,149.9 L384.4,152.0 L389.3,153.5 L391.9,152.1 L394.6,153.0 L400.1,151.4 L402.9,153.3 L404.5,150.7 L406.8,150.5 L405.9,151.4 L407.8,153.6 L401.5,156.4 L398.4,159.8 L403.3,163.2 L403.7,166.3 L400.9,165.4 L398.0,166.9 L399.2,170.4 L394.0,168.2 L392.1,168.9 L391.9,170.5 L388.9,170.1 L388.3,172.0 L385.6,173.0 L383.6,179.0 L381.2,178.6 L380.8,180.0 L378.3,178.8 L374.7,179.0 L371.8,182.5 L368.4,181.2 L369.2,179.4 L365.4,179.1 L363.9,176.5 L361.9,177.2 L357.8,175.9 L356.2,179.4 L348.7,180.2 L344.9,182.3 L344.7,181.5 L341.2,182.5 L339.2,180.2 L336.5,182.2 L333.7,182.3 L333.1,183.6 L329.2,181.3 L329.2,179.6 L325.6,180.9 L323.3,178.6 L320.9,180.2 L313.6,180.2 L314.4,178.7 L311.4,176.5 L310.1,173.0 L310.6,170.4 L320.3,166.9 L325.2,162.8 L329.2,163.6 L330.0,162.5 L333.1,163.3 L335.9,162.6 L333.9,160.4 L324.4,157.2 L323.7,155.2 L326.6,155.1 L326.8,153.2 L321.5,152.0 L325.0,149.2 L331.5,149.3 L328.0,147.7 L328.2,145.9 L324.4,145.5 L321.9,139.1 L320.1,139.1 L321.7,138.2 L320.9,137.4 L325.8,136.2Z M388.6,131.3 L388.6,131.4 L388.6,131.3 L388.6,131.3Z M387.8,131.2 L387.6,131.3 L387.5,131.3 L387.5,131.3Z M387.8,131.2 L387.9,131.2 L387.8,131.2 L387.8,131.2Z","cx":360.4,"cy":158.4},{"n":"Chandigarh","d":`,
  `"M181.9,88.1 L179.4,87.0 L181.5,86.5 L181.9,88.1Z","cx":181.2,"cy":87.4},{"n":"Chhattisgarh","d":"M310.3,186.4 L313.8,187.4 L314.8,189.9 L317.5,190.5 L318.9,193.6 L322.3,194.2 L323.7,193.2 L322.9,196.8 L324.8,197.5 L324.0,200.3 L326.4,202.9 L327.2,202.0 L330.8,202.6 L330.9,204.0 L327.8,207.0 L323.7,208.5 L323.5,211.3 L316.0,213.8 L314.2,216.2 L315.2,218.9 L313.0,219.8 L312.0,221.2 L313.2,221.9 L311.2,222.2 L310.3,223.7 L311.6,225.9 L309.1,225.5 L307.5,228.9 L296.6,228.7 L293.1,233.4 L290.9,232.5 L290.3,237.2 L292.5,238.9 L291.7,244.1 L298.0,245.1 L298.0,247.1 L295.7,248.2 L295.7,246.8 L292.7,246.4 L290.7,247.4 L288.6,245.0 L284.4,244.8 L282.9,243.6 L281.5,244.3 L281.1,246.2 L285.2,248.1 L284.4,252.0 L287.6,253.1 L287.2,257.2 L288.8,260.3 L285.6,263.1 L281.9,263.9 L283.0,265.2 L278.9,268.1 L274.8,269.4 L271.8,275.8 L267.5,275.1 L265.1,275.9 L263.7,270.6 L261.6,271.2 L261.0,269.8 L259.0,270.6 L260.2,269.5 L259.0,267.3 L254.3,264.2 L251.3,264.8 L249.3,262.5 L251.5,261.5 L249.9,259.2 L252.1,255.7 L255.8,253.4 L256.6,254.7 L259.4,255.0 L261.4,254.0 L260.2,253.0 L262.2,252.4 L257.6,250.5 L255.3,247.5 L252.3,247.9 L254.5,246.8 L252.7,246.0 L254.9,246.0 L255.4,244.0 L252.3,243.0 L252.1,241.6 L256.8,240.3 L256.8,236.5 L254.1,236.2 L256.0,235.4 L255.3,231.8 L252.9,230.7 L253.7,228.4 L257.8,226.6 L258.8,220.8 L260.6,220.2 L262.5,215.0 L264.3,215.6 L266.5,210.3 L270.6,209.2 L272.2,210.3 L276.5,208.9 L279.3,207.2 L279.5,204.2 L282.9,202.9 L282.9,201.1 L287.0,200.3 L287.8,197.5 L283.6,196.4 L282.5,194.6 L276.3,194.9 L275.6,193.8 L277.9,191.9 L276.3,189.2 L279.7,190.6 L282.5,189.7 L294.3,191.0 L299.8,188.4 L302.8,189.7 L306.3,189.4 L310.3,186.4Z","cx":283.7,"cy":229.6},{"n":"Dadra and Nagar Haveli","d":"M106.4,240.9 L108.6,239.9 L110.2,240.6 L107.8,242.2 L111.2,242.3 L110.6,244.1 L106`,
  `.4,243.4 L105.0,241.2 L106.4,240.9Z","cx":108.1,"cy":241.7},{"n":"Daman and Diu","d":"M103.9,238.3 L103.9,238.4 L104.0,238.4 L103.9,238.5Z M65.0,235.0 L65.0,235.0 L65.0,235.0 L65.0,235.0Z M66.2,234.7 L67.2,235.0 L65.0,235.0 L66.2,234.7Z M62.7,231.4 L65.2,232.3 L63.6,233.0 L65.2,233.4 L64.0,235.2 L60.7,234.2 L62.7,231.4Z","cx":72.9,"cy":234.9},{"n":"Delhi","d":"M189.8,116.3 L192.2,119.6 L190.2,122.5 L182.3,120.5 L184.1,119.3 L184.3,116.6 L187.0,115.7 L189.8,116.3Z","cx":187.5,"cy":118.3},{"n":"Goa","d":"M122.0,309.5 L122.0,309.5 L122.0,309.5 L122.0,309.5Z M122.3,309.2 L122.3,309.2 L122.3,309.2 L122.3,309.2Z M123.7,308.8 L123.7,308.8 L123.7,308.8 L123.7,308.8Z M124.0,303.7 L126.3,306.0 L131.5,305.5 L133.0,310.4 L131.5,310.8 L132.2,313.9 L130.5,315.5 L127.1,315.5 L124.6,313.3 L124.2,309.6 L122.0,308.8 L124.4,308.8 L122.2,308.1 L120.0,304.5 L124.0,303.7Z","cx":124.8,"cy":309.2},{"n":"Gujarat","d":"M64.5,234.3 L64.5,234.4 L64.5,234.4 L64.5,234.4Z M103.6,234.2 L103.6,234.2 L103.6,234.2 L103.6,234.2Z M74.9,232.7 L74.9,232.7 L74.8,232.7 L74.8,232.7Z M77.4,232.1 L77.4,232.1 L77.4,232.1 L77.4,232.1Z M80.0,231.2 L80.0,231.2 L80.0,231.2 L80.0,231.2Z M80.7,230.9 L80.7,230.9 L80.7,230.9 L80.7,230.9Z M81.1,230.9 L81.1,230.9 L81.1,230.9 L81.1,230.9Z M81.2,230.9 L81.2,230.9 L81.2,230.9 L81.2,230.9Z M99.7,229.8 L99.7,229.8 L99.7,229.8 L99.7,229.8Z M100.3,229.4 L100.3,229.5 L100.3,229.5 L100.3,229.5Z M100.2,229.2 L100.2,229.2 L100.2,229.2 L100.2,229.2Z M100.7,229.1 L100.7,229.1 L100.8,229.1 L100.8,229.2Z M100.2,228.6 L100.2,228.6 L100.3,228.6 L100.3,228.6Z M88.9,227.0 L88.9,227.0 L88.9,227.0 L88.9,227.0Z M98.5,226.0 L98.5,226.0 L98.5,226.0 L98.5,226.1Z M98.4,225.7 L98.4,225.7 L98.4,225.7 L98.4,225.7Z M98.7,225.3 L98.7,225.4 L98.7,225.4 L98.7,225.5Z M99.3,224.9 L99.3,224.9 L99.3,224.9 L99.`,
  `3,224.9Z M99.4,224.9 L99.4,224.9 L99.5,224.9 L99.5,224.9Z M100.2,224.5 L100.2,224.5 L100.2,224.5 L100.2,224.5Z M42.0,222.8 L42.0,222.8 L42.1,222.8 L42.1,222.8Z M42.1,222.1 L42.1,222.2 L42.1,222.2 L42.1,222.2Z M93.9,222.1 L93.9,222.1 L93.9,222.1 L93.9,222.1Z M98.4,221.9 L98.4,221.9 L98.4,221.9 L98.4,221.9Z M98.9,221.9 L98.9,221.9 L98.9,221.9 L98.9,221.9Z M99.0,221.9 L99.0,221.9 L99.0,221.9 L99.0,221.9Z M99.1,221.8 L99.1,221.8 L99.1,221.8 L99.1,221.8Z M98.7,221.8 L98.7,221.8 L98.7,221.8 L98.7,221.8Z M99.1,221.8 L99.1,221.8 L99.1,221.8 L99.1,221.8Z M98.8,221.7 L98.8,221.7 L98.8,221.7 L98.8,221.8Z M101.2,221.4 L101.2,221.4 L101.2,221.4 L101.2,221.4Z M92.3,220.2 L92.3,220.2 L92.3,220.2 L92.3,220.2Z M93.9,217.4 L93.9,217.4 L93.9,217.4 L93.9,217.4Z M91.1,216.5 L91.1,216.5 L91.1,216.5 L91.1,216.6Z M96.2,213.6 L96.2,213.6 L96.2,213.6 L96.2,213.6Z M94.5,213.5 L94.5,213.5 L94.5,213.5 L94.5,213.5Z M94.2,213.3 L94.2,213.3 L94.2,213.3 L94.2,213.3Z M33.9,212.2 L33.9,212.2 L33.9,212.2 L33.9,212.3Z M36.7,211.5 L36.7,211.5 L36.7,211.5 L36.7,211.5Z M31.4,211.4 L31.4,211.4 L31.4,211.4 L31.4,211.4Z M31.6,211.3 L31.6,211.3 L31.6,211.3 L31.6,211.3Z M32.0,211.1 L32.0,211.1 L32.0,211.1 L32.0,211.1Z M31.7,211.1 L31.7,211.1 L31.7,211.1 L31.7,211.1Z M34.4,211.1 L34.4,211.1 L34.4,211.1 L34.4,211.1Z M37.3,210.9 L37.3,210.9 L37.3,210.9 L37.3,210.9Z M33.3,210.6 L33.3,210.6 L33.3,210.6 L33.3,210.6Z M33.3,210.6 L33.3,210.6 L33.3,210.6 L33.3,210.6Z M30.6,210.1 L30.6,210.1 L30.6,210.1 L30.6,210.1Z M40.1,210.0 L40.1,210.0 L40.2,210.0 L40.2,210.1Z M33.7,209.8 L33.7,209.8 L33.7,209.8 L33.7,209.8Z M30.5,209.8 L30.5,209.8 L30.5,209.8 L30.5,209.8Z M29.5,209.6 L29.5,209.6 L29.5,209.6 L29.5,209.6Z M34.2,209.1 L34.2,209.1 L34.2,209.1 L34.2,209.1Z M46.4,209.0 L46.4,209.0 L46.4,209.0 L46.4,209.0Z M35.8,209.0 L35.8,2`,
  `09.0 L35.8,209.0 L35.8,209.0Z M46.6,208.9 L46.6,209.0 L46.6,209.0 L46.6,209.0Z M46.7,208.8 L46.7,208.8 L46.7,208.8 L46.7,208.8Z M46.5,208.7 L46.5,208.7 L46.5,208.7 L46.5,208.7Z M45.9,208.7 L45.9,208.7 L45.9,208.7 L45.9,208.7Z M48.0,208.7 L48.0,208.7 L48.0,208.7 L48.0,208.7Z M47.7,208.7 L47.7,208.7 L47.7,208.7 L47.7,208.7Z M47.9,208.6 L47.9,208.6 L48.0,208.6 L48.0,208.6Z M48.3,208.5 L48.3,208.5 L48.3,208.5 L48.3,208.5Z M48.4,208.4 L48.4,208.4 L48.4,208.4 L48.4,208.4Z M51.1,208.3 L51.1,208.3 L51.1,208.3 L51.1,208.3Z M47.7,208.1 L47.7,208.1 L47.7,208.1 L47.7,208.1Z M51.2,208.0 L51.2,208.0 L51.2,208.0 L51.2,208.0Z M46.5,207.9 L46.5,207.9 L46.5,207.9 L46.5,207.9Z M51.7,207.4 L51.7,207.4 L51.7,207.4 L51.7,207.4Z M52.1,206.8 L52.1,206.8 L52.1,206.8 L52.1,206.8Z M52.3,206.8 L52.3,206.8 L52.3,206.8 L52.3,206.8Z M52.3,206.7 L52.3,206.7 L52.4,206.7 L52.4,206.7Z M52.3,206.3 L52.3,206.3 L52.3,206.3 L52.3,206.3Z M40.4,205.7 L40.4,205.7 L40.5,205.7 L40.5,205.7Z M40.3,205.5 L40.3,205.5 L40.3,205.5 L40.3,205.5Z M56.5,202.3 L56.5,202.4 L56.4,202.4 L56.4,202.4Z M56.2,201.6 L56.2,201.6 L56.2,201.6 L56.2,201.6Z M56.3,201.5 L56.3,201.5 L56.3,201.5 L56.3,201.5Z M56.4,201.5 L56.4,201.5 L56.4,201.5 L56.4,201.5Z M56.5,201.5 L56.5,201.5 L56.5,201.5 L56.5,201.5Z M56.4,201.4 L56.4,201.4 L56.4,201.4 L56.4,201.4Z M56.7,201.4 L56.7,201.4 L56.8,201.4 L56.8,201.4Z M57.0,201.3 L57.0,201.4 L57.0,201.4 L57.0,201.4Z M20.1,199.0 L20.1,199.0 L20.1,199.0 L20.1,199.0Z M19.8,198.5 L19.8,198.5 L19.8,198.5 L19.8,198.5Z M21.0,198.4 L21.0,198.4 L21.0,198.4 L21.0,198.4Z M20.5,198.1 L20.5,198.1 L20.5,198.1 L20.5,198.1Z M22.0,197.8 L22.0,197.8 L22.0,197.8 L22.0,197.8Z M19.1,197.8 L19.1,197.8 L19.1,197.8 L19.1,197.8Z M20.7,197.8 L20.7,197.8 L20.7,197.8 L20.7,197.8Z M20.5,197.7 L20.5,197.7 L20.5,197.7 L20.5,197.7Z M20.7,`,
  `197.7 L20.7,197.7 L20.7,197.7 L20.7,197.7Z M19.7,197.7 L19.7,197.7 L19.7,197.7 L19.7,197.7Z M20.5,197.7 L20.5,197.7 L20.5,197.7 L20.5,197.7Z M20.4,197.7 L20.4,197.7 L20.4,197.7 L20.4,197.7Z M20.4,197.6 L20.4,197.6 L20.4,197.6 L20.4,197.6Z M18.7,197.4 L18.7,197.4 L18.7,197.4 L18.7,197.4Z M18.9,197.4 L18.9,197.4 L18.9,197.4 L18.9,197.4Z M19.0,197.4 L19.0,197.4 L19.0,197.4 L19.0,197.4Z M18.0,197.4 L18.0,197.4 L18.0,197.4 L18.0,197.4Z M18.4,197.3 L18.4,197.3 L18.5,197.3 L18.5,197.3Z M19.2,197.3 L19.2,197.3 L19.2,197.3 L19.2,197.3Z M20.5,197.2 L20.5,197.2 L20.5,197.2 L20.5,197.2Z M17.4,197.1 L17.4,197.2 L17.4,197.2 L17.4,197.2Z M19.4,197.1 L19.4,197.1 L19.4,197.1 L19.4,197.1Z M19.8,197.1 L19.8,197.1 L19.9,197.1 L19.9,197.1Z M19.7,196.9 L19.7,196.9 L19.7,196.9 L19.7,196.9Z M18.7,196.8 L18.7,196.9 L18.7,196.9 L18.7,196.9Z M18.0,196.8 L18.0,196.8 L18.0,196.8 L18.0,196.8Z M18.0,196.7 L18.0,196.8 L18.0,196.8 L18.0,196.8Z M18.6,196.7 L18.6,196.7 L18.6,196.7 L18.6,196.8Z M19.5,196.7 L19.5,196.7 L19.5,196.7 L19.5,196.7Z M18.6,196.7 L18.6,196.7 L18.6,196.7 L18.6,196.7Z M19.0,196.5 L19.0,196.5 L19.0,196.5 L19.0,196.5Z M18.7,196.5 L18.7,196.5 L18.7,196.5 L18.7,196.5Z M17.1,196.5 L17.1,196.5 L17.1,196.5 L17.1,196.5Z M18.4,196.5 L18.4,196.5 L18.4,196.5 L18.4,196.5Z M17.3,196.4 L17.3,196.4 L17.4,196.4 L17.4,196.5Z M16.5,196.4 L16.5,196.4 L16.6,196.4 L16.6,196.4Z M17.2,196.4 L17.2,196.4 L17.2,196.4 L17.2,196.4Z M16.1,196.4 L16.1,196.4 L16.1,196.4 L16.1,196.4Z M19.0,196.4 L19.0,196.4 L19.0,196.4 L19.0,196.4Z M16.2,196.4 L16.2,196.4 L16.2,196.4 L16.2,196.4Z M17.1,196.3 L17.1,196.3 L17.2,196.3 L17.2,196.4Z M18.9,196.3 L18.9,196.3 L18.9,196.3 L18.9,196.3Z M16.0,196.2 L16.0,196.2 L16.0,196.2 L16.0,196.2Z M16.0,196.2 L16.0,196.2 L16.0,196.2 L16.0,196.2Z M15.9,196.1 L15.9,196.1 L15.9,196.1 L15.9,`,
  `196.1Z M17.9,196.1 L17.9,196.1 L17.9,196.1 L17.9,196.1Z M18.2,196.1 L18.2,196.1 L18.3,196.1 L18.3,196.1Z M17.9,196.0 L17.9,196.0 L17.9,196.0 L17.9,196.0Z M17.9,195.9 L17.9,195.9 L18.0,195.9 L18.0,195.9Z M17.9,195.8 L17.9,195.8 L17.9,195.8 L17.9,195.8Z M18.0,195.7 L18.0,195.7 L18.1,195.7 L18.1,195.7Z M16.1,195.7 L16.1,195.7 L16.1,195.7 L16.1,195.7Z M17.9,195.4 L17.9,195.4 L17.9,195.4 L17.9,195.5Z M17.3,195.4 L17.5,196.5 L17.3,195.7 L16.3,196.2 L17.3,195.4Z M17.9,195.2 L17.9,195.2 L17.9,195.2 L17.9,195.3Z M18.0,195.2 L18.0,195.2 L18.1,195.2 L18.1,195.2Z M18.1,195.2 L18.1,195.2 L18.1,195.2 L18.1,195.2Z M17.7,195.1 L17.7,195.2 L17.7,195.2 L17.7,195.2Z M17.3,195.1 L17.3,195.1 L17.3,195.1 L17.3,195.1Z M16.7,195.1 L16.7,195.1 L16.7,195.1 L16.7,195.1Z M17.5,195.1 L17.5,195.1 L17.5,195.1 L17.5,195.1Z M17.3,194.7 L17.3,194.7 L17.3,194.7 L17.3,194.8Z M17.4,194.7 L17.4,194.7 L17.4,194.7 L17.4,194.7Z M17.4,194.5 L17.4,194.6 L17.4,194.6 L17.4,194.6Z M17.6,194.4 L17.6,194.4 L17.6,194.4 L17.6,194.4Z M17.5,194.3 L17.5,194.3 L17.5,194.3 L17.5,194.3Z M12.5,193.8 L12.5,193.8 L12.5,193.8 L12.5,193.8Z M13.1,193.8 L13.1,193.8 L13.1,193.8 L13.1,193.8Z M12.3,193.8 L12.3,193.8 L12.3,193.8 L12.3,193.8Z M17.6,193.7 L17.6,193.7 L17.6,193.7 L17.6,193.7Z M17.1,193.6 L17.1,193.6 L17.2,193.6 L17.2,193.6Z M17.6,193.5 L17.6,193.5 L17.6,193.5 L17.6,193.5Z M17.1,193.3 L17.1,193.3 L17.1,193.3 L17.1,193.3Z M17.6,193.2 L17.6,193.2 L17.7,193.2 L17.7,193.2Z M17.5,191.9 L17.5,191.9 L17.5,191.9 L17.5,191.9Z M16.9,191.7 L16.9,191.7 L16.9,191.7 L16.9,191.7Z M17.3,191.6 L17.3,191.6 L17.3,191.6 L17.3,191.6Z M17.7,191.5 L17.7,191.5 L17.6,191.5 L17.6,191.6Z M12.3,191.0 L12.3,191.1 L12.3,191.1 L12.3,191.1Z M14.9,190.7 L14.9,190.8 L14.9,190.8 L14.9,190.8Z M15.2,190.6 L16.5,190.9 L15.7,192.9 L12.0,193.6 L14.2,192.9 L12.6,`,
  `193.1 L15.2,190.6Z M20.0,190.6 L20.0,190.6 L20.0,190.6 L20.0,190.6Z M19.8,190.6 L19.8,190.6 L19.8,190.6 L19.8,190.6Z M14.1,190.4 L14.1,190.4 L14.2,190.4 L14.2,190.4Z M17.9,190.3 L18.3,191.5 L16.7,191.6 L17.9,190.3Z M22.0,190.0 L22.0,190.0 L22.0,190.0 L22.0,190.0Z M21.8,190.0 L21.8,190.0 L21.9,190.0 L21.9,190.0Z M18.6,189.7 L18.6,189.7 L18.6,189.7 L18.6,189.7Z M15.9,189.6 L16.5,190.6 L14.6,190.9 L15.9,189.6Z M12.9,189.6 L12.9,189.6 L13.0,189.6 L13.0,189.6Z M16.9,188.7 L16.9,188.7 L16.9,188.7 L16.9,188.7Z M18.7,188.6 L19.7,189.0 L18.3,189.9 L18.7,188.6Z M18.4,188.6 L18.4,188.6 L18.4,188.6 L18.4,188.6Z M17.5,188.0 L18.3,189.0 L16.7,190.0 L17.5,188.0Z M16.5,187.9 L12.8,192.5 L12.2,190.3 L16.5,187.9Z M88.9,178.6 L93.8,178.8 L91.8,179.4 L95.6,180.6 L96.0,181.9 L97.6,180.4 L100.7,181.2 L101.3,182.6 L105.0,183.1 L106.8,180.9 L108.6,180.7 L108.2,182.2 L111.2,182.6 L108.2,185.2 L111.5,187.7 L113.9,186.0 L114.9,188.9 L113.7,190.9 L116.7,192.2 L116.7,193.3 L119.6,193.3 L119.0,195.8 L123.0,195.8 L124.2,197.4 L125.5,196.8 L128.5,198.1 L128.9,199.7 L131.3,199.6 L133.4,203.3 L135.8,204.3 L133.8,207.5 L131.7,207.5 L129.3,209.2 L127.1,208.9 L128.7,210.6 L130.1,209.8 L132.0,211.0 L130.1,212.0 L127.7,211.5 L129.9,215.3 L128.3,216.3 L129.3,217.2 L122.6,219.2 L124.4,221.3 L122.2,221.9 L123.6,223.7 L132.4,222.7 L132.8,223.7 L127.7,224.0 L125.3,225.2 L125.3,226.6 L123.0,227.0 L122.8,228.4 L118.3,228.4 L124.6,231.1 L125.3,234.5 L119.8,237.1 L115.5,235.0 L114.5,235.9 L116.5,237.4 L114.3,239.5 L115.1,242.0 L112.7,242.0 L111.7,243.3 L110.2,242.0 L108.0,242.7 L110.2,240.9 L108.8,239.9 L105.0,241.0 L106.0,242.0 L101.5,243.0 L102.3,240.3 L104.3,239.6 L104.5,234.4 L101.1,228.9 L99.3,229.7 L99.7,227.6 L98.5,226.9 L101.5,223.0 L99.3,223.9 L98.7,223.0 L103.5,221.3 L97.6,221.5 L98.1,219.2 L96.8,217.2 L98.`,
  `3,213.8 L101.9,214.2 L105.0,212.6 L97.6,212.6 L96.6,213.8 L94.0,211.2 L95.2,213.3 L94.0,212.8 L93.6,214.9 L92.6,213.8 L92.4,217.6 L91.6,215.9 L92.8,215.0 L90.3,216.0 L91.2,217.2 L89.9,216.9 L91.8,218.0 L92.0,220.3 L90.5,219.2 L93.0,221.9 L88.5,226.6 L89.1,228.0 L68.2,234.7 L64.6,235.0 L65.2,233.4 L63.6,233.0 L65.0,231.6 L62.1,231.0 L60.7,234.4 L49.5,229.4 L41.8,223.3 L42.4,221.6 L41.6,222.5 L40.2,221.8 L41.8,223.2 L39.4,222.0 L26.6,212.2 L29.1,209.8 L29.1,210.9 L31.5,210.6 L30.9,212.2 L32.3,212.9 L37.4,211.8 L37.6,210.3 L39.2,212.0 L42.2,209.9 L43.5,210.9 L44.1,209.5 L44.9,210.2 L47.1,208.9 L50.6,208.7 L57.1,201.1 L54.4,203.3 L49.8,202.9 L50.4,201.9 L50.0,203.4 L43.5,204.4 L41.8,206.2 L40.2,205.2 L37.0,205.6 L31.5,204.6 L21.1,200.1 L19.7,199.0 L23.0,197.5 L20.9,198.0 L17.7,195.1 L17.9,192.9 L23.0,189.7 L18.5,191.3 L18.3,190.5 L21.1,189.0 L18.9,188.4 L22.8,188.4 L23.2,183.6 L25.6,184.9 L26.8,183.8 L27.8,184.5 L39.6,183.8 L42.0,185.2 L47.5,185.4 L49.8,183.6 L58.7,181.8 L58.7,184.2 L63.4,184.7 L69.8,182.0 L67.4,181.5 L67.2,180.0 L69.4,178.0 L73.1,179.0 L77.8,178.0 L83.0,178.1 L84.1,179.1 L84.5,178.0 L85.7,178.7 L87.9,177.5 L88.9,178.6Z","cx":48.7,"cy":205.3},{"n":"Haryana","d":"M182.3,85.1 L188.4,88.1 L187.6,89.9 L189.4,91.3 L194.3,91.4 L193.9,92.5 L195.5,91.7 L197.1,93.0 L193.6,97.0 L190.8,97.9 L187.8,102.1 L187.8,112.2 L189.8,115.4 L184.3,116.6 L184.1,119.3 L182.1,120.2 L183.1,121.2 L186.9,121.1 L188.8,122.8 L192.0,121.2 L194.7,122.8 L196.1,129.7 L190.0,132.1 L186.3,131.6 L187.0,132.8 L185.3,132.8 L184.9,134.0 L183.1,133.4 L184.7,126.8 L182.7,125.6 L176.4,129.4 L176.4,128.3 L174.6,128.2 L175.0,126.7 L171.5,126.2 L172.5,128.5 L169.3,128.0 L168.7,128.9 L170.1,131.3 L165.0,131.0 L164.2,130.0 L166.5,127.9 L164.6,127.6 L167.5,126.5 L164.2,123.4 L161.2,122.8 L157.1,119.7 L155.`,
  `3,114.9 L156.1,113.7 L153.1,111.7 L153.9,109.9 L147.6,110.4 L142.9,107.8 L138.2,108.8 L136.8,107.0 L138.4,105.8 L138.4,102.5 L135.6,101.8 L137.2,100.6 L136.6,99.4 L139.1,100.2 L142.1,98.8 L145.8,100.8 L147.6,99.9 L147.8,101.5 L149.6,101.1 L150.6,102.5 L149.2,103.8 L150.4,105.5 L154.7,101.5 L157.3,102.6 L161.2,101.2 L166.5,102.5 L170.5,100.6 L169.1,99.7 L170.7,97.1 L169.7,96.2 L172.1,97.0 L173.8,95.6 L174.6,97.1 L177.6,97.4 L178.4,95.4 L176.6,94.7 L180.0,93.6 L180.7,91.9 L184.1,92.7 L180.7,85.0 L182.3,85.1Z","cx":170.4,"cy":110.1},{"n":"Himachal Pradesh","d":"M181.5,48.3 L183.9,51.6 L188.2,52.4 L192.0,54.9 L199.5,52.5 L204.8,58.5 L212.5,55.8 L212.9,58.0 L210.7,59.8 L213.9,59.8 L215.4,61.2 L213.9,63.8 L216.8,64.3 L217.0,65.9 L220.4,67.7 L218.8,71.0 L221.5,73.7 L219.2,75.2 L224.9,81.4 L222.3,81.6 L221.0,80.0 L214.4,80.2 L212.3,78.8 L203.0,81.0 L199.1,86.8 L201.4,90.5 L196.7,92.8 L187.8,90.2 L188.4,88.1 L183.5,84.8 L177.8,83.3 L178.2,79.9 L174.2,78.9 L172.9,76.5 L171.7,78.3 L169.1,78.5 L163.6,68.5 L157.5,66.5 L159.1,65.2 L158.3,64.1 L164.4,61.2 L162.8,59.8 L164.0,55.8 L161.6,53.8 L165.6,53.6 L173.4,49.0 L178.2,49.5 L181.5,48.3Z","cx":192.3,"cy":68.4},{"n":"Jammu and Kashmir","d":"M203.2,13.1 L207.4,12.3 L205.0,14.4 L210.1,24.9 L216.4,26.4 L224.5,30.9 L224.1,32.7 L219.2,35.1 L220.6,39.8 L219.2,41.7 L226.3,48.4 L233.0,49.2 L231.8,52.4 L235.5,56.0 L235.7,58.2 L231.0,60.1 L228.8,59.8 L226.9,62.0 L224.5,62.4 L220.6,60.2 L220.0,56.8 L211.3,60.2 L212.5,55.8 L204.8,58.5 L199.5,52.5 L192.0,54.9 L188.2,52.4 L183.9,51.6 L181.1,47.9 L180.1,49.2 L173.4,49.0 L164.8,53.8 L162.0,53.2 L164.2,57.7 L155.9,63.4 L147.4,60.2 L140.1,60.2 L138.9,58.2 L140.1,54.6 L136.8,56.1 L132.6,53.3 L133.2,51.7 L126.5,48.9 L130.1,44.8 L125.5,40.6 L130.7,38.2 L131.5,36.6 L130.5,35.5 L124.0,35.4 L125.9,32.0 L124.`,
  `4,30.4 L121.6,30.2 L125.3,27.0 L125.5,24.9 L129.1,25.1 L133.8,23.3 L160.8,27.8 L175.0,23.5 L179.2,24.0 L180.5,21.2 L185.5,21.1 L185.9,19.5 L188.6,19.3 L201.6,12.0 L203.2,13.1Z","cx":179.3,"cy":41.6},{"n":"Jharkhand","d":"M394.4,168.8 L398.0,169.6 L398.0,172.0 L401.7,174.8 L398.8,176.7 L400.3,177.4 L400.5,179.3 L397.8,179.4 L398.6,181.9 L395.2,184.4 L396.2,185.7 L392.3,186.1 L391.7,188.1 L387.3,187.3 L388.3,189.3 L387.3,190.3 L378.5,190.3 L378.5,192.3 L371.6,193.2 L368.8,196.2 L363.9,193.9 L363.9,195.2 L360.1,195.8 L359.5,199.4 L361.1,200.4 L363.7,200.3 L367.0,202.4 L373.5,202.4 L371.4,203.4 L371.2,205.4 L375.1,207.0 L375.7,208.3 L377.9,208.5 L377.7,210.2 L380.4,213.0 L377.7,213.6 L372.7,211.8 L371.4,212.3 L363.7,208.6 L361.9,210.0 L363.5,213.9 L361.1,217.0 L358.2,216.8 L358.9,215.0 L356.6,215.9 L350.9,214.3 L347.7,216.6 L345.1,215.2 L342.8,215.5 L345.3,212.5 L344.4,209.8 L329.2,211.8 L323.5,209.2 L325.0,207.5 L327.8,207.0 L331.1,203.1 L327.2,202.0 L326.4,202.9 L324.0,200.3 L324.8,197.5 L322.9,196.8 L323.7,193.2 L322.3,194.2 L318.9,193.6 L317.5,190.5 L314.8,189.9 L313.8,187.4 L310.1,186.4 L312.6,182.6 L311.6,180.6 L320.9,180.2 L323.3,178.6 L325.6,180.9 L329.4,179.7 L329.2,181.3 L333.1,183.6 L333.7,182.3 L336.5,182.2 L339.2,180.2 L341.2,182.5 L344.7,181.5 L344.9,182.3 L348.7,180.2 L356.2,179.4 L357.8,175.9 L361.9,177.2 L363.9,176.5 L365.4,179.1 L369.2,179.4 L368.4,181.2 L371.8,182.5 L374.7,179.0 L378.3,178.8 L380.8,180.0 L381.2,178.6 L383.6,179.0 L386.1,172.4 L388.3,172.0 L388.9,170.1 L391.9,170.5 L392.3,168.8 L394.4,168.8Z","cx":359.8,"cy":191.8},{"n":"Karnataka","d":"M139.6,339.0 L139.6,339.0 L139.6,339.0 L139.6,339.0Z M140.7,337.9 L140.7,337.9 L140.7,337.9 L140.7,337.9Z M140.1,337.8 L140.1,337.9 L140.1,337.9 L140.1,337.9Z M140.6,337.8 L140.6,337.8 L140.6,337.8 L140.6,3`,
  `37.8Z M139.9,337.2 L139.9,337.2 L140.0,337.2 L140.0,337.2Z M139.9,337.1 L139.9,337.1 L139.9,337.1 L139.9,337.1Z M139.8,337.0 L139.8,337.0 L139.8,337.0 L139.8,337.0Z M139.6,336.5 L139.6,336.5 L139.6,336.5 L139.6,336.5Z M135.9,327.9 L135.9,327.9 L135.9,327.9 L135.9,327.9Z M132.8,327.8 L132.8,327.8 L132.8,327.8 L132.8,327.8Z M134.3,323.8 L134.3,323.8 L134.3,323.8 L134.3,323.8Z M133.5,320.5 L133.5,320.5 L133.5,320.5 L133.5,320.5Z M131.3,318.4 L131.3,318.4 L131.3,318.4 L131.3,318.4Z M131.1,318.4 L131.1,318.4 L131.1,318.4 L131.1,318.4Z M129.4,318.0 L129.4,318.0 L129.4,318.0 L129.4,318.0Z M128.5,317.7 L128.5,317.7 L128.5,317.7 L128.5,317.7Z M128.1,317.2 L128.1,317.2 L128.1,317.2 L128.1,317.2Z M127.4,316.9 L127.4,316.9 L127.5,316.9 L127.5,316.9Z M127.6,316.9 L127.6,316.9 L127.6,316.9 L127.6,316.9Z M127.5,316.9 L127.5,316.9 L127.6,316.9 L127.6,316.9Z M128.2,316.6 L128.2,316.6 L128.2,316.6 L128.2,316.6Z M128.3,316.5 L128.3,316.5 L128.3,316.5 L128.3,316.5Z M128.2,316.1 L128.2,316.1 L128.3,316.1 L128.3,316.1Z M192.2,266.9 L193.6,267.6 L192.6,268.7 L197.3,269.1 L196.3,272.3 L198.3,273.4 L194.1,278.8 L199.1,279.9 L195.5,280.9 L193.0,283.8 L195.3,286.7 L193.7,291.6 L194.5,292.7 L190.2,294.2 L197.1,296.7 L195.1,297.2 L195.5,301.8 L189.0,301.4 L185.9,303.0 L187.8,305.4 L186.1,305.8 L184.9,307.7 L188.6,310.8 L188.6,312.2 L187.0,314.4 L180.9,313.5 L180.7,314.8 L182.9,315.2 L180.7,319.9 L182.9,321.7 L184.9,321.5 L183.1,322.8 L184.3,324.8 L187.6,325.2 L188.4,323.4 L191.0,323.6 L193.0,325.5 L193.2,323.7 L195.3,324.5 L195.3,326.0 L192.4,326.5 L193.4,326.7 L192.0,327.8 L193.9,328.5 L193.4,329.7 L191.6,327.8 L188.4,328.2 L185.9,327.4 L185.9,325.8 L183.3,325.9 L186.3,329.0 L185.3,331.6 L188.8,331.5 L189.0,329.2 L189.0,330.0 L193.7,330.3 L194.9,332.5 L198.3,331.1 L199.5,331.8 L201.6,329.0 L204.8,`,
  `328.8 L204.0,330.5 L206.0,329.6 L207.4,330.3 L206.8,333.0 L208.3,332.9 L208.7,334.1 L212.9,333.8 L212.5,337.4 L216.6,338.2 L213.5,342.1 L214.1,343.7 L212.1,342.7 L209.5,345.1 L201.8,343.6 L199.9,346.3 L197.1,346.3 L197.7,349.7 L194.7,352.6 L199.9,353.0 L200.6,353.8 L198.5,356.1 L194.9,356.2 L193.7,358.6 L190.2,358.0 L187.6,359.2 L185.5,358.0 L183.5,358.2 L182.3,361.1 L176.8,360.5 L175.6,359.3 L173.8,359.9 L173.8,358.6 L167.9,357.3 L167.9,355.7 L163.2,355.9 L161.8,354.3 L159.1,354.0 L154.3,351.3 L153.3,349.7 L154.1,348.5 L152.7,349.0 L151.4,347.9 L152.6,347.3 L147.0,346.3 L145.8,344.6 L143.5,345.1 L138.8,330.1 L136.2,327.8 L134.0,320.6 L132.4,321.0 L131.3,318.0 L128.1,317.2 L128.3,315.8 L131.7,314.8 L132.6,311.9 L131.5,310.8 L133.0,310.4 L131.5,305.5 L128.3,305.2 L130.9,303.6 L133.4,303.8 L135.6,300.1 L133.6,300.0 L136.2,299.3 L136.2,297.5 L132.8,297.0 L133.6,295.3 L131.9,293.2 L134.0,293.4 L135.8,291.6 L137.6,293.1 L139.9,292.4 L140.1,290.7 L144.5,290.0 L144.9,287.7 L147.8,287.6 L150.4,289.1 L151.8,287.6 L159.3,287.4 L159.1,283.3 L157.5,281.6 L158.7,280.2 L161.8,281.7 L163.6,281.0 L164.4,282.4 L168.1,281.7 L169.3,282.7 L170.5,281.7 L173.2,282.6 L172.3,278.7 L175.4,277.7 L176.0,276.3 L179.4,277.4 L181.3,275.4 L180.3,274.4 L183.9,274.1 L184.5,270.5 L187.6,270.9 L190.2,267.3 L192.2,266.9Z","cx":160.5,"cy":319.4},{"n":"Kerala","d":"M175.0,388.4 L175.0,388.4 L175.0,388.4 L175.0,388.4Z M173.7,388.4 L173.7,388.4 L173.7,388.4 L173.7,388.5Z M174.3,388.3 L174.3,388.3 L174.3,388.3 L174.3,388.3Z M174.4,388.3 L174.4,388.3 L174.4,388.3 L174.4,388.3Z M173.9,388.1 L173.9,388.1 L173.9,388.1 L173.9,388.1Z M173.4,387.3 L173.4,387.3 L173.4,387.3 L173.4,387.3Z M173.3,386.1 L173.3,386.1 L173.3,386.1 L173.3,386.1Z M173.1,385.5 L173.1,385.5 L173.1,385.5 L173.1,385.5Z M172.1,384.6 L172.1,384.6 `,
  `L172.2,384.6 L172.2,384.6Z M173.1,384.6 L173.1,384.6 L173.1,384.6 L173.1,384.6Z M173.0,384.6 L173.0,384.6 L173.0,384.6 L173.0,384.6Z M173.2,384.4 L173.2,384.4 L173.2,384.4 L173.2,384.4Z M173.2,384.4 L173.2,384.4 L173.2,384.4 L173.2,384.4Z M171.5,384.3 L171.5,384.3 L171.5,384.3 L171.5,384.3Z M172.6,383.9 L172.6,383.9 L172.7,383.9 L172.7,383.9Z M171.8,383.3 L171.8,383.3 L171.8,383.3 L171.8,383.3Z M170.9,382.6 L170.9,382.6 L170.9,382.6 L170.9,382.6Z M171.1,382.6 L171.1,382.6 L171.1,382.6 L171.1,382.6Z M170.6,382.5 L170.6,382.5 L170.6,382.5 L170.6,382.5Z M171.0,382.2 L171.0,382.2 L171.0,382.2 L171.0,382.2Z M170.5,382.0 L170.5,382.1 L170.5,382.1 L170.5,382.1Z M170.7,382.0 L170.7,382.1 L170.8,382.1 L170.8,382.1Z M170.9,381.8 L170.9,381.8 L170.9,381.8 L170.9,381.8Z M171.0,381.8 L171.0,381.8 L171.0,381.8 L171.0,381.9Z M170.5,380.9 L170.5,380.9 L170.5,380.9 L170.5,380.9Z M166.8,375.0 L166.8,375.0 L166.8,375.0 L166.8,375.1Z M166.8,375.0 L166.8,375.0 L166.8,375.0 L166.8,375.0Z M162.6,367.0 L162.6,367.0 L162.6,367.0 L162.6,367.0Z M162.0,366.6 L162.0,366.6 L162.0,366.6 L162.0,366.6Z M153.3,356.0 L153.3,356.1 L153.3,356.1 L153.3,356.1Z M153.3,356.0 L153.3,356.0 L153.3,356.0 L153.3,356.1Z M152.0,355.8 L152.0,355.8 L152.0,355.8 L152.0,355.8Z M151.9,355.7 L151.9,355.7 L151.9,355.7 L151.9,355.7Z M151.7,355.4 L151.7,355.4 L151.7,355.4 L151.7,355.4Z M151.9,355.0 L151.9,355.0 L151.9,355.0 L151.9,355.0Z M151.9,354.9 L151.9,354.9 L151.9,354.9 L151.9,355.0Z M149.2,353.8 L149.2,353.8 L149.2,353.8 L149.2,353.8Z M149.3,353.7 L149.3,353.7 L149.3,353.7 L149.3,353.7Z M149.9,353.7 L149.9,353.7 L149.9,353.7 L149.9,353.7Z M149.1,353.3 L149.1,353.3 L149.1,353.3 L149.1,353.3Z M148.7,352.7 L148.7,352.8 L148.7,352.8 L148.7,352.8Z M148.6,352.7 L148.6,352.7 L148.6,352.7 L148.6,352.7Z M148.6,352.6 L148.6,352.`,
  `6 L148.6,352.6 L148.6,352.6Z M148.5,352.5 L148.5,352.5 L148.5,352.5 L148.5,352.5Z M146.0,344.6 L147.0,346.3 L152.6,347.3 L151.4,347.8 L152.7,349.0 L154.1,348.5 L153.3,349.7 L154.3,351.3 L157.5,353.2 L161.8,354.3 L163.4,356.1 L167.9,355.7 L168.1,357.4 L173.8,358.6 L174.2,360.3 L170.3,361.2 L170.5,362.6 L176.4,364.1 L174.6,366.3 L180.1,365.9 L179.4,366.9 L181.3,368.2 L178.6,369.9 L183.5,371.9 L182.9,373.8 L181.5,373.8 L181.9,378.2 L184.9,379.4 L189.8,377.7 L191.0,379.4 L189.2,381.0 L190.6,382.8 L188.4,387.5 L192.2,387.6 L193.4,389.0 L188.0,395.5 L190.2,397.5 L188.6,399.1 L190.8,401.8 L189.2,402.5 L188.6,404.9 L185.1,404.0 L176.6,397.0 L172.5,390.0 L170.5,382.6 L172.7,386.1 L172.1,384.0 L173.1,384.7 L172.9,388.6 L175.2,388.8 L173.2,384.1 L169.9,380.2 L170.1,382.5 L167.1,375.0 L164.0,371.6 L163.0,366.9 L158.3,362.3 L155.9,358.0 L154.9,358.4 L152.0,356.1 L153.3,355.8 L151.4,355.1 L153.9,353.4 L150.4,353.9 L150.0,355.1 L143.5,345.1 L146.0,344.6Z","cx":165.9,"cy":372.3},{"n":"Lakshadweep","d":"M106.8,405.3 L106.8,405.3 L106.8,405.3 L106.8,405.3Z M108.2,404.7 L108.2,404.7 L108.2,404.7 L108.2,404.7Z M92.6,381.6 L92.6,381.6 L92.6,381.6 L92.6,381.6Z M119.1,381.3 L119.1,381.3 L119.1,381.3 L119.1,381.3Z M119.0,381.2 L119.0,381.2 L119.0,381.2 L119.0,381.2Z M119.5,380.8 L119.5,380.9 L119.5,380.9 L119.5,380.9Z M93.4,380.4 L93.4,380.4 L93.4,380.4 L93.4,380.4Z M119.6,380.1 L119.6,380.1 L119.7,380.1 L119.7,380.2Z M99.6,374.5 L99.6,374.5 L99.6,374.5 L99.6,374.5Z M90.2,371.3 L90.2,371.3 L90.2,371.3 L90.2,371.3Z M90.3,371.2 L90.3,371.2 L90.3,371.2 L90.3,371.2Z M120.0,371.2 L120.0,371.2 L120.0,371.2 L120.0,371.2Z M90.3,371.2 L90.3,371.2 L90.3,371.2 L90.3,371.2Z M92.6,369.5 L92.6,369.5 L92.6,369.5 L92.6,369.5Z M93.3,369.4 L93.3,369.4 L93.3,369.4 L93.3,369.4Z M93.5,369.3 L93.5,369.3 L93.5,369.3`,
  ` L93.5,369.4Z M101.3,366.9 L101.3,366.9 L101.3,366.9 L101.3,366.9Z M89.0,365.9 L89.0,365.9 L89.0,365.9 L89.0,365.9Z M88.9,365.9 L88.9,365.9 L88.9,365.9 L88.9,365.9Z M102.5,365.3 L102.5,365.3 L102.5,365.3 L102.5,365.3Z M106.6,362.2 L106.6,362.2 L106.7,362.2 L106.7,362.2Z M106.6,362.1 L106.6,362.1 L106.6,362.1 L106.6,362.1Z M90.6,360.7 L90.6,360.7 L90.6,360.7 L90.6,360.7Z M101.0,359.2 L101.0,359.2 L101.0,359.2 L101.0,359.2Z","cx":101.4,"cy":373.8},{"n":"Madhya Pradesh","d":"M212.3,145.8 L216.4,147.4 L219.4,146.8 L224.7,148.6 L224.5,150.2 L227.5,153.6 L223.7,156.6 L224.9,157.5 L222.1,161.6 L220.0,162.3 L221.1,164.2 L213.7,165.1 L211.1,167.9 L213.9,171.4 L211.7,172.0 L211.7,173.3 L208.3,175.3 L210.5,178.1 L209.5,180.3 L212.7,183.9 L215.2,182.2 L220.8,185.2 L224.3,182.8 L222.5,178.6 L220.0,179.1 L220.6,176.1 L217.4,173.9 L216.4,169.5 L213.7,169.1 L218.0,166.9 L220.2,168.0 L221.1,167.0 L219.6,166.0 L221.5,167.0 L222.7,165.1 L224.5,167.7 L220.6,168.9 L221.7,169.9 L222.5,168.3 L224.1,168.2 L222.5,171.0 L224.9,170.4 L224.9,169.2 L225.3,171.3 L226.5,170.5 L227.3,171.7 L230.4,171.5 L230.2,169.6 L231.8,170.2 L230.0,169.2 L230.8,168.3 L231.8,169.4 L234.6,169.4 L232.8,171.7 L234.6,172.1 L236.1,170.7 L241.7,171.8 L241.7,169.8 L249.7,167.0 L252.9,170.8 L250.1,172.4 L250.7,173.3 L254.3,172.6 L254.1,171.8 L256.6,172.3 L256.2,171.0 L257.8,172.6 L260.0,172.4 L258.4,171.3 L261.0,171.7 L262.0,170.4 L260.4,174.2 L265.9,174.0 L266.9,174.9 L268.5,174.3 L269.6,170.8 L273.8,172.3 L275.6,170.4 L276.1,172.4 L282.1,173.2 L283.2,175.8 L288.0,175.9 L287.4,177.1 L288.8,176.5 L289.7,179.0 L292.1,179.1 L292.3,177.5 L294.5,178.4 L297.0,177.7 L299.8,179.1 L298.0,179.7 L299.0,183.6 L297.0,186.0 L300.0,188.4 L296.5,190.2 L293.9,190.9 L282.5,189.7 L280.3,190.6 L277.3,188.9 L276.1,189.4 L277.9,191.9 L275.6,193`,
  `.8 L276.3,194.9 L282.5,194.6 L283.6,196.4 L287.8,197.5 L287.0,200.3 L282.9,201.1 L282.9,202.9 L279.5,204.2 L279.3,207.2 L276.5,208.9 L272.2,210.3 L270.6,209.2 L266.5,210.3 L264.3,215.6 L262.5,215.0 L260.6,220.2 L258.8,220.8 L257.6,226.0 L252.5,225.5 L249.7,222.0 L243.0,223.5 L239.3,222.3 L235.5,223.2 L234.6,221.3 L229.4,220.6 L229.2,221.6 L223.1,222.5 L223.5,223.9 L213.7,223.7 L212.7,222.0 L204.0,225.3 L196.9,225.7 L195.1,225.5 L193.7,223.3 L197.5,223.2 L196.1,220.9 L194.9,219.9 L191.2,220.0 L181.5,222.3 L181.1,224.2 L178.0,226.0 L178.0,228.1 L175.4,228.0 L173.2,229.7 L169.1,229.7 L167.7,225.6 L150.4,225.0 L144.1,221.9 L137.4,221.2 L135.2,216.2 L132.0,217.5 L129.3,217.3 L128.3,216.3 L129.9,215.3 L127.7,211.5 L130.1,212.0 L132.0,211.0 L130.1,209.8 L128.7,210.6 L127.1,208.9 L129.3,209.2 L131.7,207.5 L133.8,207.5 L135.8,204.3 L132.6,201.4 L141.1,199.3 L136.6,197.5 L138.4,195.7 L144.9,193.2 L144.3,189.7 L145.8,187.4 L143.9,184.1 L141.1,183.8 L143.3,181.0 L140.3,180.4 L142.5,178.1 L142.1,176.2 L143.9,178.3 L146.4,176.7 L143.1,176.4 L142.7,173.7 L146.8,175.3 L149.2,172.6 L152.9,172.7 L151.2,174.9 L154.3,175.3 L152.2,176.1 L150.2,174.6 L150.4,177.4 L162.6,177.2 L164.0,181.2 L161.6,180.9 L160.4,181.9 L162.4,184.2 L160.6,185.8 L162.4,186.7 L159.8,188.3 L156.1,187.1 L155.1,189.0 L157.5,190.7 L159.4,191.3 L159.8,189.3 L161.4,190.0 L165.4,188.9 L165.0,187.4 L168.3,186.4 L169.5,183.1 L170.1,184.7 L175.0,184.5 L176.2,185.5 L179.4,183.6 L179.6,185.4 L183.5,186.0 L184.3,184.8 L181.7,180.2 L183.7,180.0 L184.9,181.2 L186.7,179.6 L186.1,177.5 L181.5,175.9 L184.5,175.2 L182.5,173.2 L193.4,171.7 L192.6,167.3 L191.0,167.2 L189.6,168.8 L180.9,168.8 L176.8,166.9 L175.2,162.8 L177.4,160.5 L180.5,160.0 L187.8,155.1 L201.4,150.5 L203.0,148.9 L207.0,148.6 L207.4,146.8 L212.3,145.8Z","cx":210.2,"cy`,
  `":186.0},{"n":"Maharashtra","d":"M115.6,302.2 L115.6,302.2 L115.6,302.2 L115.6,302.2Z M115.7,302.2 L115.7,302.2 L115.8,302.2 L115.8,302.2Z M115.8,302.1 L115.8,302.1 L115.8,302.1 L115.8,302.1Z M115.7,300.0 L115.7,300.0 L115.7,300.0 L115.7,300.1Z M115.4,299.3 L115.4,299.3 L115.4,299.3 L115.4,299.3Z M108.3,275.5 L108.3,275.5 L108.3,275.5 L108.3,275.5Z M107.4,272.3 L107.4,272.3 L107.4,272.3 L107.4,272.3Z M105.9,268.8 L105.9,268.8 L106.0,268.8 L106.0,268.8Z M108.2,268.7 L108.2,268.7 L108.2,268.7 L108.2,268.7Z M108.2,268.5 L108.2,268.5 L108.2,268.5 L108.2,268.5Z M104.0,264.1 L104.0,264.1 L104.0,264.1 L104.0,264.1Z M102.9,263.1 L102.9,263.1 L102.9,263.1 L102.9,263.1Z M103.5,263.1 L103.5,263.1 L103.5,263.1 L103.5,263.1Z M104.7,259.5 L104.7,259.5 L104.7,259.5 L104.7,259.5Z M105.4,259.4 L105.4,259.4 L105.4,259.4 L105.4,259.4Z M107.1,259.0 L107.1,259.0 L107.2,259.0 L107.2,259.0Z M102.3,257.1 L102.3,257.1 L102.3,257.1 L102.3,257.1Z M101.3,252.5 L101.3,252.5 L101.3,252.5 L101.3,252.5Z M135.0,216.2 L138.0,221.5 L144.1,221.9 L152.0,225.3 L167.7,225.6 L168.5,229.0 L171.3,229.7 L178.0,228.1 L178.0,226.0 L181.1,224.2 L181.5,222.3 L191.2,220.0 L194.9,219.9 L196.1,220.9 L197.5,223.2 L193.7,223.3 L195.1,225.5 L196.9,225.7 L204.0,225.3 L212.7,222.0 L213.7,223.7 L223.5,223.9 L223.1,222.5 L229.2,221.6 L229.4,220.6 L234.6,221.3 L235.5,223.2 L239.3,222.3 L243.0,223.5 L249.7,222.0 L252.5,225.5 L257.8,226.4 L253.1,229.4 L256.0,235.4 L254.1,236.2 L256.8,236.5 L256.8,240.3 L252.1,241.6 L252.3,243.0 L255.4,244.0 L254.9,246.0 L252.7,246.0 L254.5,246.8 L252.3,247.9 L255.3,247.5 L257.6,250.5 L262.2,252.4 L260.2,253.0 L261.4,254.0 L259.4,255.0 L256.6,254.7 L255.8,253.4 L254.1,254.3 L249.9,259.2 L251.5,261.7 L246.8,263.5 L242.4,261.4 L243.2,258.7 L241.8,257.6 L243.4,256.6 L244.0,253.4 L240.5,250.7 L234.2,`,
  `252.0 L229.6,250.5 L228.4,252.6 L223.9,251.3 L224.3,249.9 L222.1,249.8 L221.9,248.4 L214.8,247.9 L211.3,246.2 L212.5,248.1 L210.5,249.8 L211.3,252.6 L208.7,253.3 L208.5,255.7 L204.2,254.3 L202.4,254.8 L202.2,257.8 L200.5,258.6 L204.0,261.5 L199.9,263.5 L200.1,265.3 L197.3,265.3 L195.9,267.0 L196.7,268.7 L192.6,268.7 L193.6,267.6 L191.8,266.7 L187.6,270.9 L184.5,270.5 L183.9,274.1 L180.3,274.4 L181.3,275.4 L179.4,277.4 L176.0,276.3 L175.4,277.7 L172.3,278.7 L173.2,282.6 L170.5,281.7 L169.3,282.7 L168.1,281.7 L164.4,282.4 L163.6,281.0 L161.8,281.7 L158.7,280.2 L157.5,281.6 L159.1,283.3 L159.3,287.4 L151.8,287.6 L150.4,289.1 L147.8,287.6 L144.9,287.7 L144.5,290.0 L140.1,290.7 L139.9,292.4 L137.6,293.1 L135.8,291.6 L134.0,293.4 L131.7,293.2 L133.6,295.3 L132.8,297.0 L136.4,297.9 L136.0,299.4 L133.6,300.0 L135.6,300.1 L133.4,303.8 L130.9,303.6 L126.9,306.2 L123.8,303.4 L120.0,304.4 L115.5,299.8 L114.7,295.2 L112.9,293.6 L114.3,293.1 L112.9,292.4 L111.5,286.5 L112.9,286.3 L110.4,282.7 L111.4,282.6 L110.0,281.2 L109.2,275.4 L105.2,269.9 L105.8,269.1 L108.4,270.9 L108.4,268.4 L107.2,269.4 L104.8,268.1 L103.9,263.2 L104.1,261.8 L106.2,261.7 L104.8,260.4 L107.2,259.0 L105.8,258.2 L102.9,260.6 L103.3,256.5 L102.3,256.6 L103.5,255.2 L102.3,256.4 L102.5,251.6 L101.1,251.5 L99.7,247.1 L100.5,245.5 L101.7,246.0 L101.5,243.0 L104.1,241.7 L110.2,244.3 L112.7,242.0 L115.1,242.2 L114.3,239.5 L116.5,237.4 L114.5,235.8 L115.7,235.0 L119.8,237.1 L125.3,234.5 L124.6,231.1 L118.3,228.4 L122.8,228.4 L125.3,225.2 L133.0,223.2 L123.6,223.7 L122.2,221.9 L124.4,220.9 L122.6,219.2 L135.0,216.2Z","cx":155.2,"cy":261.3},{"n":"Manipur","d":"M532.0,163.8 L531.6,165.8 L534.0,166.6 L532.2,170.1 L535.4,171.3 L535.2,172.9 L527.1,182.9 L523.7,190.0 L517.0,188.9 L515.9,187.7 L510.9,188.6 L507.8,186.3 L506.0,1`,
  `87.6 L505.8,186.5 L502.8,187.1 L500.5,186.3 L503.0,176.1 L504.8,176.1 L508.8,169.5 L510.1,168.8 L512.9,170.4 L517.4,165.1 L520.8,164.5 L526.7,166.1 L532.0,163.8Z","cx":518.2,"cy":176.1},{"n":"Meghalaya","d":"M478.2,157.2 L479.6,158.6 L487.1,157.5 L484.3,159.5 L485.7,160.0 L484.3,163.5 L488.8,162.3 L492.4,165.1 L494.0,164.7 L492.4,166.4 L496.5,168.5 L496.9,170.1 L491.4,171.3 L489.6,172.9 L482.5,170.5 L474.1,171.5 L466.8,170.4 L450.6,171.3 L438.4,168.9 L439.2,165.4 L442.1,164.4 L439.8,162.5 L444.1,159.2 L451.2,158.3 L451.8,160.1 L453.2,159.2 L454.0,160.1 L460.3,159.4 L462.0,160.3 L461.4,161.3 L465.4,160.7 L465.8,162.8 L468.0,161.0 L471.9,160.5 L470.7,160.5 L472.9,158.2 L474.7,160.0 L475.8,157.7 L478.2,157.2Z","cx":470.7,"cy":163.1},{"n":"Mizoram","d":"M496.9,181.8 L501.3,182.2 L500.5,186.3 L507.6,187.1 L509.5,192.5 L508.6,200.3 L506.8,202.1 L503.4,201.6 L504.2,203.4 L502.6,206.5 L505.0,212.9 L503.8,214.0 L501.9,213.8 L501.1,216.9 L500.1,216.2 L499.1,217.3 L495.4,214.5 L493.2,216.9 L491.6,206.9 L488.6,203.3 L489.2,198.7 L486.3,190.6 L487.7,189.2 L487.1,184.2 L489.4,184.2 L490.4,186.0 L496.3,180.3 L496.9,181.8Z","cx":498.0,"cy":199.0},{"n":"Nagaland","d":"M544.4,144.7 L545.0,148.4 L541.7,151.8 L543.1,152.9 L542.7,157.0 L544.0,157.5 L540.7,160.0 L541.3,162.2 L538.3,165.0 L533.0,166.4 L531.6,165.8 L531.8,163.0 L526.7,166.1 L520.8,164.5 L517.4,165.1 L512.9,170.2 L510.9,169.8 L509.9,167.0 L507.4,165.2 L516.0,159.1 L516.6,161.4 L520.2,159.8 L520.6,156.1 L526.1,150.4 L526.9,151.8 L529.7,148.7 L535.6,147.3 L538.7,144.6 L540.7,144.9 L544.2,143.2 L544.4,144.7Z","cx":530.4,"cy":157.2},{"n":"Orissa","d":"M338.6,257.5 L338.6,257.6 L338.6,257.6 L338.6,257.6Z M338.4,257.5 L338.4,257.5 L338.4,257.5 L338.4,257.5Z M338.9,257.5 L338.9,257.5 L338.9,257.5 L338.9,257.5Z M367.6,246.3 L367.6,246.`,
  `3 L367.6,246.3 L367.6,246.3Z M370.2,245.6 L370.2,245.6 L370.2,245.6 L370.2,245.6Z M370.5,245.5 L370.5,245.5 L370.5,245.5 L370.5,245.5Z M370.6,245.5 L370.6,245.5 L370.6,245.5 L370.6,245.5Z M370.1,245.3 L370.2,245.4 L370.2,245.4 L370.2,245.4Z M369.2,245.1 L369.2,245.1 L369.2,245.1 L369.2,245.1Z M369.2,245.0 L369.2,245.0 L369.2,245.0 L369.2,245.0Z M369.5,245.1 L369.5,245.1 L369.5,245.1 L369.5,245.1Z M369.0,244.8 L369.0,244.8 L369.0,244.8 L369.0,244.8Z M367.9,244.6 L367.9,244.6 L367.9,244.6 L367.9,244.6Z M371.0,244.7 L371.0,244.7 L371.0,244.7 L371.0,244.7Z M368.3,244.6 L368.2,244.6 L368.2,244.6 L368.2,244.7Z M369.2,244.6 L369.2,244.6 L369.2,244.6 L369.2,244.6Z M369.1,244.5 L369.1,244.5 L369.1,244.5 L369.1,244.5Z M368.1,244.5 L368.1,244.5 L368.1,244.5 L368.1,244.5Z M369.0,244.4 L369.0,244.4 L369.0,244.4 L369.0,244.4Z M368.8,244.4 L368.8,244.4 L368.8,244.4 L368.9,244.4Z M371.3,244.4 L371.3,244.4 L371.3,244.4 L371.3,244.5Z M368.7,244.3 L368.7,244.3 L368.7,244.3 L368.7,244.3Z M368.2,244.2 L368.2,244.2 L368.2,244.2 L368.2,244.2Z M368.1,244.2 L368.0,244.2 L368.0,244.2 L368.0,244.2Z M371.5,244.1 L371.5,244.2 L371.5,244.2 L371.5,244.2Z M372.6,242.9 L372.6,242.9 L372.6,242.9 L372.6,242.9Z M372.8,242.5 L372.8,242.5 L372.8,242.5 L372.8,242.5Z M373.8,242.1 L373.8,242.1 L373.8,242.1 L373.8,242.1Z M378.5,239.7 L378.5,239.7 L378.5,239.7 L378.5,239.7Z M378.5,239.6 L378.5,239.6 L378.5,239.6 L378.6,239.6Z M378.5,239.6 L378.5,239.6 L378.5,239.5 L378.5,239.5Z M378.7,239.0 L378.7,239.1 L378.7,239.1 L378.7,239.1Z M378.5,239.5 L378.4,239.5 L378.4,239.5 L378.4,239.5Z M378.7,238.5 L378.7,238.5 L378.7,238.5 L378.7,238.5Z M378.8,238.0 L378.8,238.1 L378.8,238.1 L378.8,238.1Z M380.1,235.5 L380.1,235.5 L380.1,235.5 L380.1,235.5Z M378.6,235.2 L378.6,235.2 L378.6,235.2 L378.6,235.2Z M382.7,234.9 L382.6,23`,
  `4.9 L382.6,234.9 L382.6,234.9Z M382.8,235.0 L382.7,235.0 L382.7,235.0 L382.7,235.0Z M383.7,234.5 L383.7,234.5 L383.7,234.5 L383.7,234.5Z M384.0,234.6 L384.0,234.6 L384.0,234.6 L384.0,234.6Z M384.4,234.3 L384.4,234.3 L384.4,234.3 L384.4,234.3Z M380.0,234.1 L382.6,234.8 L379.8,235.7 L380.2,234.7 L378.1,235.8 L380.0,234.1Z M380.1,234.0 L380.1,234.0 L380.2,234.0 L380.2,234.0Z M379.9,233.9 L379.9,234.0 L379.9,234.0 L380.0,234.0Z M382.3,233.9 L382.3,233.9 L382.3,233.9 L382.3,234.0Z M381.6,233.9 L381.6,233.9 L381.6,233.9 L381.6,233.9Z M380.3,233.8 L380.3,233.8 L380.4,233.8 L380.4,233.8Z M382.9,233.6 L382.9,233.7 L382.9,233.7 L382.9,233.7Z M385.0,223.5 L385.0,223.5 L385.0,223.5 L385.0,223.5Z M364.5,209.0 L371.4,212.3 L372.7,211.8 L377.1,213.5 L377.1,214.6 L382.0,215.5 L383.2,218.5 L387.1,217.3 L387.9,219.5 L391.9,220.5 L392.1,222.2 L384.8,223.5 L379.0,228.1 L382.0,233.4 L379.2,234.1 L377.9,236.4 L383.6,235.0 L377.3,238.2 L378.1,240.3 L372.0,242.7 L372.1,243.6 L373.9,242.2 L370.6,245.3 L367.8,244.3 L370.0,245.7 L351.4,250.3 L338.8,257.5 L336.7,256.8 L335.1,258.9 L334.7,258.0 L331.7,258.9 L331.9,260.3 L329.6,262.1 L321.3,261.7 L316.0,256.9 L314.2,258.9 L312.8,258.0 L312.8,259.7 L309.9,259.2 L311.6,261.4 L307.9,262.9 L306.3,262.2 L303.9,264.1 L305.5,265.5 L304.1,266.9 L304.7,267.7 L301.8,268.0 L299.8,266.9 L296.5,269.8 L293.3,265.5 L291.1,267.3 L290.5,268.5 L291.7,268.7 L290.1,270.2 L291.1,271.2 L289.4,273.1 L284.4,272.2 L276.3,275.5 L271.8,275.6 L274.8,269.4 L278.9,268.1 L283.0,265.2 L281.9,263.9 L285.6,263.1 L288.8,260.3 L287.2,257.2 L287.6,253.1 L284.4,252.0 L285.2,248.1 L281.1,246.2 L281.5,244.4 L282.9,243.6 L284.4,244.8 L288.6,245.0 L290.7,247.4 L292.7,246.4 L295.7,247.0 L295.7,248.2 L297.8,247.4 L298.0,245.1 L291.7,244.1 L292.5,238.9 L290.3,237.2 L290.9,232.5 L293.1,233.4 L2`,
  `96.6,228.7 L303.0,228.3 L306.1,229.4 L309.1,225.5 L311.6,225.9 L310.3,223.7 L311.2,222.2 L313.2,221.9 L312.0,221.2 L313.0,219.8 L315.2,218.9 L314.2,216.2 L316.2,213.6 L323.5,211.3 L323.3,209.0 L329.2,211.8 L344.4,209.8 L345.3,212.5 L343.0,215.5 L345.1,215.2 L347.7,216.6 L350.3,214.5 L356.6,215.9 L358.9,215.0 L358.2,216.8 L361.1,217.0 L363.7,212.2 L362.1,209.8 L364.5,209.0Z","cx":355.5,"cy":241.2},{"n":"Puducherry","d":"M241.5,371.1 L241.5,371.1 L241.6,371.1 L241.6,371.1Z M239.7,369.0 L241.7,369.0 L241.7,371.3 L238.7,369.9 L239.7,369.0Z M238.5,355.3 L239.5,356.5 L241.5,356.1 L240.7,357.8 L237.9,357.0 L239.1,356.8 L237.5,355.5 L238.5,355.3Z M153.3,353.2 L151.2,355.0 L152.0,355.9 L150.4,353.9 L153.3,353.2Z M289.3,291.0 L289.3,291.0 L289.3,291.0 L289.3,291.0Z M288.2,290.6 L288.3,290.7 L288.4,290.8 L288.5,290.8Z","cx":238.4,"cy":342.7},{"n":"Punjab","d":"M163.2,60.1 L164.4,61.2 L158.3,64.1 L159.1,65.2 L157.5,66.5 L163.6,68.5 L169.1,78.5 L171.7,78.3 L172.9,76.5 L174.2,78.9 L178.2,79.7 L177.8,83.3 L182.5,86.5 L179.4,87.1 L182.7,88.2 L184.1,92.7 L180.7,91.9 L180.0,93.6 L176.6,94.7 L178.4,95.4 L177.6,97.4 L174.6,97.1 L173.8,95.6 L172.1,97.0 L169.7,96.2 L170.7,97.1 L169.1,99.7 L170.5,100.6 L166.5,102.5 L161.2,101.2 L157.3,102.6 L154.7,101.5 L150.4,105.5 L149.2,103.8 L150.6,102.5 L149.6,101.1 L147.8,101.5 L147.6,99.9 L145.8,100.8 L142.1,98.8 L138.9,100.2 L124.2,99.1 L125.7,95.9 L123.8,92.8 L137.4,82.2 L139.9,81.7 L136.2,81.1 L138.9,76.2 L137.6,75.5 L136.6,72.1 L138.2,69.5 L144.3,66.7 L150.8,66.3 L153.1,64.1 L152.6,62.4 L155.3,62.4 L155.9,63.4 L163.2,58.7 L163.2,60.1Z","cx":158.8,"cy":85.1},{"n":"Rajasthan","d":"M124.2,98.9 L136.6,99.6 L137.2,100.6 L135.6,101.8 L138.4,102.5 L138.4,105.8 L136.8,107.0 L138.2,108.8 L142.9,107.8 L147.6,110.4 L153.9,109.9 L153.1,111.7 L156.1,113.7 L155.`,
  `3,114.9 L157.1,119.7 L161.2,122.8 L164.2,123.4 L167.5,126.5 L164.6,127.6 L166.5,127.9 L164.2,130.0 L165.0,131.0 L170.1,131.3 L168.7,128.9 L169.3,128.0 L172.5,128.5 L171.5,126.2 L175.0,126.7 L174.6,128.2 L176.4,128.3 L176.4,129.4 L181.7,125.6 L183.5,125.9 L184.7,126.8 L183.5,134.0 L187.0,132.8 L186.3,131.6 L191.4,131.9 L192.2,135.9 L193.9,137.9 L197.5,138.8 L198.7,140.9 L195.3,142.4 L200.5,143.5 L193.7,145.8 L194.3,147.5 L195.3,146.1 L200.3,144.7 L205.6,145.9 L207.4,144.6 L210.3,145.0 L208.7,147.0 L207.2,146.8 L207.0,148.6 L203.0,148.9 L201.4,150.5 L187.8,155.1 L180.5,160.0 L177.4,160.5 L175.2,162.8 L176.8,166.9 L180.9,168.8 L189.6,168.8 L191.0,167.2 L192.6,167.3 L193.4,171.7 L182.5,173.2 L184.5,175.2 L181.5,175.9 L186.1,177.5 L186.7,179.6 L184.9,181.2 L183.7,180.0 L181.7,180.2 L184.3,184.8 L183.5,186.0 L179.6,185.4 L179.4,183.6 L176.2,185.5 L175.0,184.5 L170.1,184.7 L169.5,183.1 L168.3,186.4 L165.0,187.4 L165.4,188.9 L161.4,190.0 L159.8,189.3 L159.4,191.3 L157.5,190.7 L155.1,189.0 L156.1,187.1 L159.8,188.3 L162.4,186.7 L160.6,185.8 L162.4,184.2 L160.4,181.9 L161.6,180.9 L164.0,181.2 L162.6,177.2 L150.4,177.4 L150.2,174.6 L152.2,176.1 L154.3,175.3 L151.2,174.9 L152.9,172.7 L149.2,172.6 L146.8,175.3 L143.1,173.7 L143.1,176.4 L146.4,176.9 L143.9,178.3 L142.1,176.2 L142.5,178.1 L140.3,180.4 L143.3,181.0 L141.1,183.8 L143.9,184.1 L145.8,187.4 L144.3,189.7 L144.9,193.2 L138.4,195.7 L136.6,197.5 L141.1,199.3 L132.6,201.4 L125.7,196.8 L124.2,197.4 L123.0,195.8 L119.0,195.8 L119.6,193.3 L116.7,193.3 L116.7,192.2 L113.7,190.9 L114.9,188.9 L113.9,186.0 L111.5,187.7 L108.2,185.2 L111.2,182.6 L108.2,182.2 L108.4,180.7 L105.0,183.1 L101.3,182.6 L100.7,181.2 L97.6,180.4 L96.0,181.9 L95.6,180.6 L91.8,179.4 L93.8,178.8 L90.3,179.0 L87.9,177.5 L85.7,178.7 L84.5,178.0 L84.1,179.1 L83.0,17`,
  `8.1 L73.1,179.0 L69.6,178.1 L65.0,171.3 L60.7,167.6 L60.7,163.0 L53.0,163.0 L49.5,159.5 L50.8,150.5 L43.9,149.9 L37.2,146.7 L39.4,141.2 L47.9,135.5 L50.6,131.5 L54.8,128.8 L58.5,128.6 L62.5,133.1 L64.8,133.4 L84.9,129.5 L85.5,127.0 L90.5,123.5 L94.4,117.5 L105.4,113.4 L111.9,105.3 L114.3,99.6 L125.7,95.6 L124.2,98.9Z","cx":144.0,"cy":158.5},{"n":"Sikkim","d":"M415.1,127.4 L418.7,128.6 L419.7,130.6 L417.5,135.5 L420.2,139.7 L416.7,141.8 L413.3,141.0 L410.8,142.7 L404.1,141.8 L402.7,140.6 L403.3,136.4 L406.3,131.3 L404.7,129.7 L415.1,127.4Z","cx":412.0,"cy":135.3},{"n":"Tamil Nadu","d":"M196.4,408.0 L196.4,408.0 L196.4,408.0 L196.4,408.0Z M207.5,400.8 L207.5,400.8 L207.5,400.8 L207.5,400.8Z M207.6,400.8 L207.6,400.8 L207.6,400.8 L207.6,400.8Z M207.6,400.5 L207.6,400.5 L207.6,400.5 L207.6,400.5Z M207.7,400.4 L207.7,400.4 L207.7,400.4 L207.7,400.4Z M207.5,400.3 L207.5,400.3 L207.5,400.3 L207.5,400.3Z M209.3,397.8 L209.3,397.8 L209.3,397.8 L209.3,397.8Z M209.6,397.4 L209.6,397.4 L209.6,397.4 L209.6,397.4Z M210.2,396.2 L210.2,396.2 L210.2,396.2 L210.2,396.2Z M214.9,394.4 L214.9,394.4 L214.9,394.4 L214.9,394.4Z M215.8,394.2 L215.8,394.2 L215.8,394.2 L215.8,394.2Z M216.6,394.2 L216.6,394.2 L216.6,394.2 L216.6,394.2Z M214.8,393.9 L214.8,393.9 L214.8,393.9 L214.8,393.9Z M218.9,393.6 L218.9,393.6 L218.9,393.6 L218.9,393.6Z M219.6,393.6 L219.6,393.6 L219.6,393.6 L219.6,393.6Z M221.5,393.4 L221.5,393.4 L221.5,393.4 L221.5,393.4Z M223.7,393.2 L223.7,393.2 L223.7,393.2 L223.7,393.2Z M224.3,393.1 L224.3,393.1 L224.3,393.1 L224.3,393.1Z M226.3,392.9 L226.3,392.9 L226.3,392.9 L226.3,392.9Z M227.7,392.8 L227.7,392.8 L227.7,392.8 L227.7,392.8Z M227.4,392.7 L227.4,392.7 L227.4,392.7 L227.4,392.7Z M229.5,392.4 L229.5,392.4 L229.5,392.4 L229.5,392.4Z M228.5,392.3 L228.5,392.3 L228.5,392.3 L22`,
  `8.5,392.3Z M229.2,392.3 L229.2,392.3 L229.2,392.3 L229.2,392.3Z M231.0,391.2 L233.6,393.5 L229.0,392.3 L231.0,391.2Z M235.3,390.5 L235.3,390.5 L235.3,390.5 L235.3,390.5Z M235.3,390.5 L235.3,390.5 L235.3,390.5 L235.3,390.5Z M235.3,390.5 L235.3,390.5 L235.3,390.5 L235.3,390.5Z M235.3,390.4 L235.3,390.4 L235.3,390.5 L235.3,390.5Z M235.3,390.4 L235.3,390.4 L235.3,390.4 L235.3,390.4Z M235.3,390.4 L235.3,390.4 L235.3,390.4 L235.3,390.4Z M235.3,390.4 L235.3,390.4 L235.3,390.4 L235.3,390.4Z M235.3,390.4 L235.3,390.4 L235.3,390.4 L235.3,390.4Z M238.8,378.4 L238.8,378.4 L238.8,378.4 L238.8,378.4Z M238.7,378.3 L238.7,378.3 L238.7,378.3 L238.7,378.3Z M238.6,378.3 L238.6,378.3 L238.6,378.3 L238.6,378.3Z M238.5,378.2 L238.5,378.2 L238.5,378.2 L238.5,378.2Z M238.4,378.2 L238.4,378.2 L238.4,378.2 L238.4,378.2Z M237.2,378.2 L237.2,378.2 L237.2,378.2 L237.2,378.2Z M236.9,378.2 L236.9,378.2 L236.9,378.2 L236.9,378.2Z M237.1,378.1 L237.1,378.1 L237.1,378.1 L237.1,378.1Z M237.2,378.1 L237.2,378.1 L237.2,378.1 L237.2,378.1Z M237.3,378.1 L237.3,378.1 L237.3,378.1 L237.3,378.1Z M238.7,378.1 L238.7,378.1 L238.7,378.1 L238.7,378.1Z M238.2,378.1 L238.2,378.1 L238.3,378.1 L238.3,378.1Z M238.5,378.1 L238.5,378.1 L238.5,378.1 L238.5,378.1Z M236.9,378.1 L236.9,378.1 L236.9,378.1 L236.9,378.1Z M238.6,377.9 L238.6,377.9 L238.6,377.9 L238.6,377.9Z M237.4,377.8 L237.4,377.8 L237.4,377.8 L237.4,377.8Z M237.2,377.6 L237.2,377.6 L237.3,377.6 L237.3,377.6Z M241.4,365.6 L241.4,365.6 L241.5,365.6 L241.5,365.6Z M241.2,365.6 L241.2,365.6 L241.2,365.6 L241.2,365.6Z M244.4,351.9 L244.4,351.9 L244.4,351.9 L244.4,351.9Z M251.0,335.7 L251.0,335.7 L251.0,335.7 L251.0,335.8Z M246.2,334.5 L251.1,336.7 L251.1,335.7 L249.5,344.7 L247.8,348.9 L245.0,350.7 L241.5,356.1 L239.5,356.5 L239.7,355.4 L237.5,355.5 L239.1,356.8 L23`,
  `7.9,357.0 L240.7,357.8 L239.9,361.2 L241.8,369.0 L239.3,368.9 L238.7,369.9 L241.7,371.3 L242.2,378.2 L239.5,378.5 L237.3,377.4 L235.7,378.1 L239.5,378.5 L235.7,377.5 L230.6,378.7 L229.4,380.4 L230.2,381.7 L222.9,389.1 L225.5,391.4 L228.6,391.9 L221.5,392.0 L212.5,394.5 L208.5,397.3 L208.3,398.7 L209.7,399.0 L207.2,400.4 L206.6,404.1 L196.3,408.0 L191.8,407.4 L187.2,405.0 L190.8,401.8 L188.6,399.1 L190.2,397.5 L188.0,395.5 L193.4,389.0 L192.2,387.6 L188.4,387.5 L190.6,382.8 L189.2,380.9 L191.0,379.4 L189.8,377.7 L184.9,379.4 L181.9,378.2 L181.5,373.8 L182.9,373.8 L183.5,371.9 L178.6,369.9 L181.3,368.2 L179.4,366.9 L180.1,365.9 L174.6,366.3 L176.4,364.1 L170.5,362.6 L170.3,361.2 L175.6,359.3 L176.8,360.5 L182.3,361.1 L183.5,358.2 L185.5,358.0 L187.6,359.2 L190.2,358.0 L193.7,358.6 L194.9,356.2 L198.5,356.1 L200.6,353.8 L194.5,352.0 L197.5,350.4 L197.1,346.3 L199.9,346.3 L201.8,343.6 L203.6,343.3 L204.8,344.4 L206.2,343.9 L209.5,345.1 L208.9,346.0 L214.1,347.0 L219.0,340.9 L222.5,340.5 L223.3,341.4 L224.5,340.6 L227.9,341.6 L229.2,339.8 L231.0,340.3 L233.2,339.1 L232.2,337.6 L233.4,337.4 L236.3,338.3 L238.1,337.9 L239.5,339.1 L239.1,338.0 L243.2,337.1 L245.4,335.2 L244.4,334.5 L246.2,334.5Z","cx":223.4,"cy":379.2},{"n":"Tripura","d":"M484.9,180.3 L486.5,182.2 L485.3,184.2 L487.7,185.1 L487.5,189.7 L485.5,192.8 L484.7,191.6 L482.5,193.1 L480.4,191.8 L480.8,195.4 L476.6,198.5 L478.0,201.0 L473.7,203.1 L469.7,198.3 L469.7,201.4 L468.5,200.8 L464.6,191.6 L465.8,191.6 L467.0,188.1 L468.9,188.1 L468.9,186.3 L473.3,186.7 L474.7,184.5 L476.4,185.8 L476.0,184.2 L479.2,185.8 L479.6,182.9 L483.5,182.3 L484.9,180.3Z","cx":477.4,"cy":189.9},{"n":"Uttar Pradesh","d":"M196.9,92.4 L203.8,94.8 L199.3,100.6 L201.0,103.5 L204.2,103.1 L205.0,105.5 L211.7,101.7 L213.3,102.1 L217.2,105.3 L223.3`,
  `,106.9 L219.2,109.0 L221.9,109.9 L222.9,111.6 L227.5,111.9 L228.0,113.5 L232.0,114.3 L233.0,116.0 L240.1,115.5 L240.3,116.7 L241.7,116.3 L244.0,118.1 L247.0,116.4 L254.9,120.6 L254.7,118.8 L255.8,118.5 L268.5,123.5 L270.6,127.0 L273.2,126.5 L281.9,131.0 L285.4,130.1 L292.9,133.7 L298.0,133.1 L298.6,136.4 L307.5,137.1 L310.1,138.9 L311.4,136.7 L316.0,136.8 L321.9,138.9 L324.4,145.5 L328.2,145.9 L328.0,147.7 L331.5,149.3 L325.0,149.2 L324.4,150.7 L321.5,151.0 L321.5,152.0 L326.8,153.2 L326.6,154.9 L323.7,155.1 L323.5,156.0 L326.8,158.8 L333.9,160.4 L335.9,162.6 L333.1,163.3 L330.0,162.5 L329.2,163.6 L325.2,162.8 L320.3,166.9 L310.4,170.7 L310.6,175.2 L314.4,178.8 L311.4,180.6 L312.6,182.6 L307.5,189.0 L302.6,189.6 L297.0,186.1 L299.0,183.6 L298.0,182.2 L298.0,179.7 L299.8,179.9 L299.0,178.4 L292.5,177.5 L292.1,179.1 L289.7,179.0 L288.8,176.5 L287.4,177.1 L288.0,175.9 L283.2,175.8 L282.1,173.2 L276.1,172.4 L275.6,170.4 L273.8,172.3 L269.6,170.8 L268.5,174.3 L266.9,174.9 L265.9,174.0 L260.4,174.2 L262.0,170.4 L261.0,171.7 L258.4,171.3 L260.0,172.4 L257.8,172.6 L256.2,171.0 L256.6,172.3 L250.1,173.0 L252.9,170.8 L249.7,167.0 L241.7,169.8 L241.8,171.8 L236.1,170.7 L234.6,172.1 L232.8,171.7 L234.6,169.4 L231.8,169.4 L230.6,168.3 L230.8,171.4 L227.5,171.7 L226.5,170.5 L225.3,171.3 L224.9,169.2 L224.9,170.4 L222.3,170.8 L223.9,168.2 L222.5,168.3 L221.7,169.9 L220.6,168.9 L224.5,167.7 L222.9,166.7 L223.5,165.1 L221.5,165.8 L221.5,167.0 L219.6,166.0 L221.1,167.0 L220.2,168.0 L218.0,166.9 L213.7,169.1 L216.4,169.5 L217.4,173.9 L220.6,176.1 L220.0,179.1 L222.5,178.6 L224.3,182.8 L220.8,185.2 L215.2,182.2 L213.3,183.8 L211.9,183.4 L212.3,182.2 L209.5,180.2 L210.5,178.1 L208.3,175.3 L211.7,173.3 L211.7,172.0 L213.9,171.4 L211.1,167.9 L213.7,165.1 L221.1,164.2 L220.0,162.3 L222.1,161.6`,
  ` L224.9,157.5 L223.7,156.6 L227.5,153.9 L227.5,152.1 L224.5,150.2 L224.7,148.6 L219.4,146.8 L216.4,147.4 L212.1,145.8 L209.3,146.2 L209.5,144.6 L205.6,145.9 L200.3,144.7 L193.9,147.3 L193.7,145.8 L200.5,143.5 L195.5,142.8 L198.7,140.9 L197.5,138.8 L193.9,137.9 L191.6,134.8 L191.0,131.8 L196.1,129.7 L194.7,127.6 L196.1,125.2 L191.4,120.5 L191.8,118.1 L189.2,116.9 L187.2,104.7 L189.2,99.9 L193.6,97.0 L196.9,92.4Z","cx":249.0,"cy":153.0},{"n":"Uttaranchal","d":"M228.6,77.9 L233.0,82.7 L236.5,84.2 L241.7,83.6 L248.9,87.0 L248.9,89.7 L256.0,91.1 L264.7,94.8 L251.9,102.5 L252.7,104.9 L249.3,107.2 L250.5,110.7 L247.6,112.3 L244.4,118.1 L241.7,116.3 L240.3,116.7 L240.1,115.5 L233.0,116.0 L232.0,114.3 L228.0,113.5 L227.5,111.9 L222.9,111.6 L221.9,109.9 L219.2,109.0 L223.3,106.9 L217.2,105.3 L214.4,102.5 L211.7,101.7 L205.0,105.5 L204.2,103.1 L201.0,103.5 L199.3,100.6 L203.8,94.8 L196.5,92.2 L201.4,90.5 L199.1,86.8 L203.0,81.0 L212.3,78.8 L214.4,80.2 L221.0,80.0 L223.7,81.6 L224.9,81.4 L223.3,78.2 L225.9,76.0 L228.6,77.9Z","cx":227.0,"cy":97.6},{"n":"West Bengal","d":"M402.7,222.7 L402.7,222.7 L402.7,222.7 L402.7,222.7Z M412.1,222.3 L412.1,222.3 L412.1,222.3 L412.1,222.3Z M405.8,222.3 L405.8,222.3 L405.8,222.3 L405.8,222.3Z M418.8,222.2 L418.8,222.2 L418.8,222.2 L418.8,222.2Z M416.7,221.8 L416.7,221.8 L416.7,221.8 L416.7,221.8Z M412.9,221.8 L412.9,221.8 L412.9,221.8 L412.9,221.8Z M419.9,221.6 L419.9,221.6 L419.9,221.6 L419.9,221.6Z M417.5,221.6 L417.5,221.6 L417.5,221.6 L417.5,221.6Z M421.3,221.7 L421.4,221.7 L421.4,221.7 L421.4,221.7Z M414.8,221.5 L414.8,221.5 L414.8,221.5 L414.8,221.5Z M413.7,221.0 L413.7,221.0 L413.7,221.0 L413.7,221.0Z M414.0,221.0 L414.0,221.0 L414.0,221.0 L414.0,221.0Z M421.7,220.8 L421.7,220.8 L421.7,220.8 L421.7,220.8Z M418.2,220.8 L418.2,220.8 L418.2,220`,
  `.8 L418.2,220.8Z M408.4,220.8 L408.5,220.8 L408.5,220.8 L408.5,220.8Z M411.3,220.8 L411.3,220.8 L411.3,220.8 L411.3,220.8Z M416.1,220.7 L416.1,220.7 L416.1,220.7 L416.1,220.7Z M406.3,220.6 L406.3,220.6 L406.4,220.6 L406.4,220.6Z M423.2,220.6 L423.2,220.6 L423.2,220.6 L423.2,220.6Z M421.6,220.5 L421.6,220.5 L421.6,220.5 L421.6,220.5Z M413.1,220.4 L413.1,220.4 L413.1,220.4 L413.1,220.4Z M406.2,220.5 L406.2,220.6 L406.1,220.5 L406.1,220.5Z M419.7,220.3 L419.7,220.3 L419.7,220.3 L419.7,220.3Z M410.4,220.5 L410.4,220.5 L410.5,220.5 L410.5,220.5Z M406.6,220.0 L408.4,221.2 L408.0,222.9 L406.6,222.0 L406.6,220.0Z M420.6,220.0 L420.6,220.0 L420.6,220.0 L420.6,220.0Z M409.5,220.0 L409.5,220.0 L409.5,220.0 L409.5,220.0Z M422.1,220.0 L422.1,220.0 L422.1,220.0 L422.2,220.0Z M418.7,219.9 L419.1,222.0 L417.3,220.9 L418.7,219.9Z M409.9,220.0 L409.9,220.0 L409.9,220.0 L409.9,220.0Z M406.3,219.9 L406.3,219.9 L406.3,219.9 L406.3,219.9Z M407.9,220.0 L407.9,220.0 L407.9,220.0 L407.8,219.9Z M413.8,219.8 L413.8,219.8 L413.8,219.8 L413.8,219.8Z M408.3,220.5 L408.3,220.6 L408.3,220.6 L408.3,220.6Z M412.3,219.7 L412.2,219.7 L412.2,219.7 L412.2,219.7Z M422.0,219.6 L422.0,220.6 L421.0,220.0 L422.0,219.6Z M414.3,219.6 L414.3,219.6 L414.4,219.6 L414.4,219.6Z M407.7,219.6 L407.7,219.6 L407.7,219.6 L407.8,219.6Z M405.9,219.6 L405.9,219.7 L405.9,219.7 L405.9,219.7Z M411.3,219.6 L411.4,219.6 L411.4,219.6 L411.4,219.6Z M416.4,219.4 L416.4,219.4 L416.4,219.4 L416.4,219.4Z M405.7,219.3 L405.7,219.4 L405.7,219.4 L405.7,219.4Z M413.0,219.3 L413.1,219.3 L413.1,219.3 L413.1,219.3Z M410.6,219.3 L410.6,219.3 L410.6,219.3 L410.7,219.3Z M422.0,219.3 L422.0,219.3 L422.0,219.3 L422.0,219.3Z M417.1,219.5 L417.1,219.5 L417.1,219.6 L417.1,219.6Z M418.6,219.4 L418.6,219.4 L418.6,219.4 L418.6,219.4Z M417.8,220.3 L417.8,2`,
  `20.3 L417.8,220.3 L417.8,220.3Z M420.4,219.1 L420.4,219.1 L420.4,219.1 L420.4,219.1Z M405.9,219.1 L405.9,219.1 L405.9,219.1 L405.9,219.1Z M413.3,219.0 L413.3,219.1 L413.3,219.1 L413.4,219.1Z M411.9,219.0 L411.9,219.0 L411.9,219.0 L411.9,219.0Z M420.9,218.8 L420.9,218.8 L420.9,218.8 L420.9,218.8Z M414.0,218.8 L414.0,218.8 L414.0,218.8 L414.0,218.8Z M412.6,218.7 L412.6,218.7 L412.6,218.7 L412.6,218.7Z M412.9,218.7 L412.9,218.7 L412.9,218.7 L412.9,218.7Z M408.8,218.6 L409.8,219.6 L408.6,220.8 L407.4,219.5 L408.8,218.6Z M419.3,218.5 L420.2,220.5 L418.7,219.8 L419.3,218.5Z M413.8,218.5 L413.8,218.5 L413.8,218.5 L413.8,218.5Z M405.1,218.3 L404.5,221.9 L403.1,221.2 L405.1,218.3Z M417.9,218.3 L417.9,218.4 L417.9,218.4 L417.9,218.4Z M421.6,218.2 L422.6,219.0 L421.4,219.8 L421.6,218.2Z M414.6,218.1 L414.6,218.1 L414.6,218.1 L414.6,218.1Z M405.0,218.1 L405.0,218.1 L405.0,218.1 L405.0,218.1Z M418.4,218.0 L418.4,218.0 L418.4,218.0 L418.4,218.0Z M413.4,218.1 L413.4,218.1 L413.4,218.1 L413.4,218.1Z M410.7,218.0 L410.7,218.0 L410.7,218.0 L410.7,218.0Z M411.2,218.0 L411.4,219.6 L410.0,219.0 L411.2,218.0Z M416.5,217.9 L416.5,217.9 L416.5,217.9 L416.5,218.0Z M404.4,218.1 L404.4,218.1 L404.4,218.1 L404.4,218.1Z M412.3,217.9 L412.3,217.9 L412.3,217.9 L412.3,217.9Z M411.2,218.0 L411.2,218.0 L411.2,218.0 L411.2,218.0Z M414.9,217.7 L414.9,217.7 L414.9,217.7 L414.9,217.7Z M405.0,217.7 L405.0,217.7 L405.0,217.7 L405.0,217.7Z M418.9,217.8 L421.6,218.5 L419.9,219.3 L418.9,217.8Z M416.6,217.6 L416.6,217.6 L416.6,217.6 L416.6,217.6Z M405.5,217.5 L405.5,217.5 L405.5,217.5 L405.5,217.5Z M417.0,216.9 L417.0,216.9 L417.0,216.9 L417.0,216.9Z M417.3,216.6 L417.3,216.7 L417.3,216.7 L417.3,216.7Z M415.3,216.3 L415.3,216.3 L415.3,216.4 L415.3,216.4Z M405.1,216.2 L405.1,216.3 L405.1,216.3 L405.1,216.3Z M418.3`,
  `,216.3 L420.0,216.5 L420.2,217.6 L417.1,217.2 L418.3,216.3Z M416.7,216.0 L416.8,216.0 L416.8,216.0 L416.8,216.0Z M417.4,215.9 L417.4,215.9 L417.4,215.9 L417.4,215.9Z M420.1,216.0 L420.1,216.0 L420.1,216.0 L420.1,216.0Z M402.9,215.8 L402.9,215.8 L402.9,215.8 L402.9,215.8Z M422.4,215.9 L423.2,217.6 L421.4,216.8 L422.4,215.9Z M414.8,215.9 L414.8,215.9 L414.8,215.9 L414.9,215.9Z M418.3,215.7 L418.3,215.8 L418.3,215.7 L418.3,215.7Z M419.5,215.5 L419.5,215.5 L419.5,215.5 L419.5,215.5Z M415.9,215.5 L415.9,215.5 L415.9,215.5 L415.9,215.5Z M420.1,215.4 L420.1,215.4 L420.1,215.4 L420.1,215.4Z M416.5,215.2 L416.5,215.2 L416.5,215.2 L416.5,215.2Z M418.1,215.4 L418.2,215.4 L418.2,215.4 L418.2,215.4Z M418.4,214.9 L418.4,214.9 L418.4,214.9 L418.4,214.9Z M416.7,215.0 L416.7,215.0 L416.7,215.0 L416.7,215.0Z M419.5,214.2 L420.4,215.3 L418.7,214.8 L419.5,214.2Z M421.0,213.9 L420.4,216.3 L421.2,215.8 L422.2,218.0 L420.2,216.8 L419.9,214.2 L421.0,213.9Z M422.0,213.8 L423.0,214.8 L421.6,216.0 L422.0,213.8Z M416.1,213.6 L417.9,214.2 L415.7,215.5 L416.5,216.5 L414.7,215.0 L416.1,213.6Z M419.0,213.9 L419.0,213.9 L419.0,213.9 L419.0,213.9Z M402.1,213.5 L402.1,213.5 L402.1,213.5 L402.1,213.5Z M420.7,213.4 L420.7,213.4 L420.7,213.4 L420.7,213.4Z M418.3,212.6 L418.7,214.2 L417.1,213.8 L418.3,212.6Z M419.1,211.5 L420.8,212.3 L420.2,213.5 L418.9,212.5 L420.4,214.2 L419.7,213.0 L419.7,213.8 L418.1,213.3 L419.1,211.5Z M421.6,211.2 L423.2,214.8 L421.0,212.9 L421.6,211.2Z M401.1,210.9 L401.1,210.9 L401.1,210.9 L401.1,210.9Z M419.3,210.9 L419.3,210.9 L419.3,210.9 L419.3,210.9Z M419.4,210.7 L419.4,210.7 L419.4,210.7 L419.4,210.8Z M420.4,210.5 L420.4,210.5 L420.4,210.5 L420.4,210.5Z M400.8,210.5 L400.8,210.5 L400.8,210.5 L400.8,210.5Z M400.6,210.4 L400.6,210.4 L400.6,210.5 L400.6,210.4Z M419.2,209.9 L419.2,`,
  `209.9 L419.2,209.9 L419.2,210.0Z M417.7,209.5 L417.7,209.5 L417.7,209.5 L417.7,209.5Z M420.0,208.7 L420.0,211.3 L418.9,209.3 L420.0,208.7Z M420.7,208.5 L420.7,208.5 L420.7,208.6 L420.8,208.6Z M420.4,208.5 L422.0,210.5 L420.8,212.2 L420.4,208.5Z M420.8,207.7 L420.8,207.8 L420.7,207.7 L420.7,207.7Z M415.6,183.3 L415.6,183.3 L415.6,183.3 L415.6,183.3Z M404.9,142.1 L410.8,142.7 L413.9,141.0 L418.1,141.8 L419.5,142.2 L419.5,144.6 L422.4,144.7 L424.6,146.7 L429.5,145.8 L434.6,147.1 L434.4,148.0 L439.0,148.3 L439.2,152.0 L436.2,154.2 L436.4,156.1 L434.6,155.2 L433.8,157.2 L434.8,157.7 L432.9,159.2 L425.4,156.7 L423.8,152.7 L421.2,151.8 L420.4,153.2 L423.4,154.8 L419.9,154.4 L419.1,155.2 L414.5,151.7 L411.0,150.5 L410.6,149.3 L409.8,149.9 L408.8,151.5 L411.8,151.8 L412.6,153.3 L405.9,156.4 L406.1,158.3 L404.1,160.0 L404.7,161.6 L407.6,161.4 L413.0,165.8 L418.3,165.7 L418.9,168.0 L422.2,169.1 L420.4,170.8 L411.2,170.4 L410.2,174.0 L408.8,175.2 L406.8,173.9 L405.1,174.2 L405.9,175.3 L402.5,178.1 L408.8,182.3 L416.7,183.8 L415.9,186.3 L417.5,188.1 L413.7,189.9 L413.3,193.1 L418.1,195.2 L416.5,198.7 L421.8,199.3 L419.1,202.3 L421.4,204.6 L421.0,207.2 L418.3,206.2 L421.2,207.9 L419.1,210.5 L415.7,208.2 L419.7,211.5 L416.7,213.8 L414.9,213.5 L415.5,211.8 L414.5,215.0 L413.5,213.9 L414.3,217.9 L413.1,217.0 L413.5,218.0 L412.0,218.3 L413.1,216.0 L411.6,218.0 L411.4,216.5 L410.4,218.2 L409.8,217.0 L410.0,219.5 L409.4,217.8 L409.2,218.6 L407.6,218.3 L407.6,220.5 L405.5,218.3 L406.3,214.2 L403.7,213.6 L404.5,212.3 L403.3,213.5 L401.9,213.0 L399.9,210.3 L401.1,212.9 L406.1,215.2 L403.5,216.5 L401.5,215.2 L403.3,216.5 L400.9,219.5 L392.1,222.2 L391.3,220.0 L387.7,219.3 L387.1,217.3 L383.2,218.5 L383.0,216.0 L377.1,214.6 L380.4,212.5 L377.9,210.5 L377.9,208.5 L375.7,208.3 L375.1,207.0 L371.2`,
  `,205.4 L371.4,203.4 L373.5,202.4 L367.0,202.4 L363.7,200.3 L361.1,200.4 L359.5,198.5 L360.3,195.5 L363.9,195.2 L363.7,193.9 L368.8,196.2 L371.6,193.2 L378.5,192.3 L378.5,190.3 L387.3,190.3 L388.3,189.3 L387.3,187.3 L391.7,188.1 L392.3,186.1 L396.2,185.7 L395.2,184.4 L398.6,181.9 L397.8,179.4 L400.5,179.3 L400.3,177.4 L398.8,176.7 L401.7,174.8 L397.8,171.8 L399.5,169.2 L397.6,167.3 L400.7,165.4 L403.7,166.0 L403.3,163.2 L398.4,159.8 L399.2,158.0 L408.0,153.5 L405.9,151.4 L406.8,150.5 L404.5,150.7 L406.1,147.3 L405.1,144.0 L402.1,142.2 L402.7,140.6 L404.9,142.1Z","cx":412.4,"cy":209.2}]`,
];
const INDIA_PATHS=JSON.parse(_IP.join(''));

// ── Pure SVG India Map — no D3, no DOM measurement, works everywhere ─────────

const _ML=68.2,_XL=97.42;
const _MY=0.141492,_XY=0.663523;
const MAP_W=600,MAP_H=420,MAP_P=12;

function lngLatToSVG(lng,lat){
  const x=(lng-_ML)/(_XL-_ML)*(MAP_W-2*MAP_P)+MAP_P;
  const r=lat*Math.PI/180;
  const my=Math.log(Math.tan(Math.PI/4+r/2));
  const y=(1-(my-_MY)/(_XY-_MY))*(MAP_H-2*MAP_P)+MAP_P;
  return [Math.round(x*10)/10, Math.round(y*10)/10];
}

// ── Regional Clusters — drill-down "districts" within key states ──────────
// Since precise district GeoJSON isn't feasible to embed, this gives a curated
// set of named investment micro-regions per state, shown as labeled clusters
// once you zoom in past state level (zoom >= 2.2). Clicking jumps to Analyze.
// REGION_CLUSTERS — initially populated from the hardcoded seed below,
// then overwritten at runtime by data fetched from /data/REGION_CLUSTERS.json
// (the ETL pipeline output). The fetch happens in useAppData() below.
// This means the app works immediately on first load (seed data) and then
// silently upgrades to ETL-computed scores if the JSON file is available.
let REGION_CLUSTERS = {
  "Karnataka": [
    {name:"Bengaluru East (Whitefield Belt)", lat:12.97, lng:77.75, score:80},
    {name:"Bengaluru North (Devanahalli/Airport)", lat:13.24, lng:77.71, score:74},
    {name:"Bengaluru South (Electronic City)", lat:12.85, lng:77.66, score:72},
    {name:"Mysuru Region", lat:12.30, lng:76.64, score:62},
    {name:"Mangaluru Coastal Belt", lat:12.87, lng:74.84, score:58},
    {name:"Hubli-Dharwad", lat:15.36, lng:75.12, score:54},
  ],
  "Maharashtra": [
    {name:"Mumbai Metropolitan Region", lat:19.08, lng:72.88, score:72},
    {name:"Pune East (Hinjewadi/Wakad)", lat:18.59, lng:73.74, score:76},
    {name:"Navi Mumbai", lat:19.03, lng:73.02, score:70},
    {name:"Thane Belt", lat:19.22, lng:72.98, score:66},
    {name:"Nagpur Region", lat:21.15, lng:79.09, score:55},
    {name:"Nashik Region", lat:20.00, lng:73.79, score:56},
  ],
  "Tamil Nadu": [
    {name:"Chennai OMR Corridor", lat:12.90, lng:80.23, score:70},
    {name:"Chennai West (Porur/Poonamallee)", lat:13.04, lng:80.16, score:64},
    {name:"Coimbatore Region", lat:11.00, lng:76.97, score:56},
    {name:"Madurai Region", lat:9.93, lng:78.12, score:50},
    {name:"Tiruchirappalli Region", lat:10.80, lng:78.69, score:48},
  ],
  "Telangana": [
    {name:"Hyderabad West (Gachibowli/HITEC City)", lat:17.44, lng:78.38, score:83},
    {name:"Hyderabad North (Kompally/Medchal)", lat:17.60, lng:78.49, score:66},
    {name:"Hyderabad South (Shamshabad)", lat:17.24, lng:78.43, score:58},
    {name:"Warangal Region", lat:18.00, lng:79.58, score:48},
  ],
  "Gujarat": [
    {name:"Ahmedabad-Gandhinagar Belt", lat:23.03, lng:72.58, score:72},
    {name:"Surat Region", lat:21.17, lng:72.83, score:64},
    {name:"Vadodara Region", lat:22.31, lng:73.18, score:60},
    {name:"Dholera SIR", lat:22.27, lng:72.19, score:59},
  ],
  "Haryana": [
    {name:"Gurugram (Cyber City/Golf Course Rd)", lat:28.47, lng:77.03, score:74},
    {name:"Faridabad Region", lat:28.41, lng:77.31, score:55},
    {name:"Panchkula Region", lat:30.69, lng:76.86, score:56},
  ],
  "Uttar Pradesh": [
    {name:"Noida-Greater Noida Belt", lat:28.57, lng:77.32, score:67},
    {name:"Lucknow Region", lat:26.85, lng:80.95, score:56},
    {name:"Agra Region", lat:27.18, lng:78.02, score:46},
  ],
  "West Bengal": [
    {name:"Kolkata New Town/Rajarhat", lat:22.58, lng:88.47, score:64},
    {name:"Kolkata South", lat:22.50, lng:88.35, score:58},
    {name:"Siliguri Region", lat:26.72, lng:88.43, score:44},
  ],
};

// ── Haversine distance (km) between two lat/lng points ─────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Periphery localities — the "ripple zones" that typically appreciate after
// nearby established hubs get saturated. Curated from known Bengaluru/Hyderabad/
// Pune market patterns. Each entry includes real lat/lng for distance computation,
// a current price range, and a trajectory comparator showing which famous locality
// this one resembles at its current growth stage. ───────────────────────────────
const PERIPHERY_LOCALITIES = [
  // South/SE Bengaluru periphery (Electronic City + Sarjapur overflow)
  {name:"Anekal",         lat:12.71, lng:77.70, score:62, price:"₹2,000–4,500/sqft",  city:"Bengaluru", historicalMirror:"Electronic City (2008–2010)", distanceNote:"18km from Electronic City"},
  {name:"Attibele",       lat:12.77, lng:77.77, score:58, price:"₹1,800–3,800/sqft",  city:"Bengaluru", historicalMirror:"Electronic City (2006)",      distanceNote:"16km from Electronic City"},
  {name:"Chandapura",     lat:12.80, lng:77.70, score:65, price:"₹2,500–5,000/sqft",  city:"Bengaluru", historicalMirror:"Electronic City (2012)",      distanceNote:"8km from Electronic City"},
  // South Bengaluru periphery (Kanakapura Road / JP Nagar overflow)
  {name:"Kaggalipura",    lat:12.76, lng:77.56, score:55, price:"₹2,500–5,500/sqft",  city:"Bengaluru", historicalMirror:"JP Nagar (2010)",             distanceNote:"18km from JP Nagar"},
  {name:"Talaghattapura", lat:12.82, lng:77.53, score:60, price:"₹3,000–6,000/sqft",  city:"Bengaluru", historicalMirror:"Kanakapura Road (2013)",       distanceNote:"14km from JP Nagar"},
  // North Bengaluru periphery (Devanahalli/Airport overflow)
  {name:"Bagalur",        lat:13.33, lng:77.77, score:60, price:"₹2,200–5,000/sqft",  city:"Bengaluru", historicalMirror:"Devanahalli (2012)",           distanceNote:"14km from Devanahalli"},
  {name:"Rajanukunte",    lat:13.17, lng:77.59, score:63, price:"₹2,800–5,500/sqft",  city:"Bengaluru", historicalMirror:"Yelahanka (2014)",             distanceNote:"12km from Devanahalli"},
  {name:"Doddaballapur",  lat:13.30, lng:77.54, score:61, price:"₹2,000–4,500/sqft",  city:"Bengaluru", historicalMirror:"Devanahalli (2011)",           distanceNote:"20km from Devanahalli"},
  // East Bengaluru periphery (Whitefield overflow)
  {name:"Hoskote",        lat:13.07, lng:77.80, score:62, price:"₹2,500–5,000/sqft",  city:"Bengaluru", historicalMirror:"Whitefield (2010)",            distanceNote:"20km from Whitefield"},
  {name:"Carmelaram",     lat:12.86, lng:77.76, score:68, price:"₹4,000–8,500/sqft",  city:"Bengaluru", historicalMirror:"Sarjapur Road (2015)",         distanceNote:"8km from Sarjapur"},
  // Outer Bengaluru / long-term speculation
  {name:"Bagepalli",      lat:13.78, lng:77.78, score:38, price:"₹500–1,500/sqft",    city:"Bengaluru", historicalMirror:"Outer Devanahalli belt (2005)", distanceNote:"65km from Devanahalli — long-term speculative"},
  {name:"Gauribidanur",   lat:13.61, lng:77.52, score:42, price:"₹600–2,000/sqft",    city:"Bengaluru", historicalMirror:"Outer Tumkur Road (2007)",      distanceNote:"75km from Bengaluru — speculative"},
  // Hyderabad periphery
  {name:"Shadnagar",      lat:17.07, lng:78.18, score:62, price:"₹2,000–4,500/sqft",  city:"Hyderabad", historicalMirror:"Shamshabad (2012)",            distanceNote:"25km from Shamshabad"},
  {name:"Patancheru",     lat:17.53, lng:78.27, score:60, price:"₹2,500–5,000/sqft",  city:"Hyderabad", historicalMirror:"Gachibowli (2010)",            distanceNote:"22km from HITEC City"},
  {name:"Mucherla",       lat:17.17, lng:78.25, score:58, price:"₹1,800–4,000/sqft",  city:"Hyderabad", historicalMirror:"Shamshabad (2009)",            distanceNote:"18km from Shamshabad"},
  // Pune periphery
  {name:"Talegaon",       lat:18.73, lng:73.67, score:62, price:"₹3,000–6,500/sqft",  city:"Pune",      historicalMirror:"Hinjewadi (2012)",             distanceNote:"30km from Hinjewadi"},
  {name:"Chakan",         lat:18.76, lng:73.86, score:65, price:"₹3,500–7,000/sqft",  city:"Pune",      historicalMirror:"Hinjewadi (2014)",             distanceNote:"22km from Hinjewadi"},
];

// Find periphery localities within a given distance band from a searched location.
// Returns only those within maxKm, sorted by distance, with computed km attached.
function getRippleZones(searchLat, searchLng, searchScore, maxKm=45) {
  return PERIPHERY_LOCALITIES
    .map(p => ({...p, km: Math.round(haversineKm(searchLat, searchLng, p.lat, p.lng))}))
    .filter(p => p.km <= maxKm)
    .sort((a,b) => a.km - b.km)
    .slice(0,5); // top 5 nearest
}



function getRegionsForState(stateName){
  return REGION_CLUSTERS[stateName] || [];
}


function IndiaMap({pins=[],onStateClick,selectedState=null,focusLat=null,focusLng=null,focusZoom=4}){
  const [tip,setTip]=useState(null);
  const [hovered,setHovered]=useState(null);
  const [zoom,setZoom]=useState(1);
  const [pan,setPan]=useState({x:0,y:0});
  const [legendOpen,setLegendOpen]=useState(false); // collapsed by default — was eating ~25% of map height on mobile

  // Auto-zoom to a specific lat/lng when provided
  useEffect(()=>{
    if(!focusLat||!focusLng) return;
    const [svgX,svgY]=lngLatToSVG(focusLng,focusLat);
    const targetZoom=focusZoom;
    // Center the target point in the viewport (MAP_W/2, MAP_H/2)
    const newPanX=(MAP_W/2)-svgX*targetZoom;
    const newPanY=(MAP_H/2)-svgY*targetZoom;
    // Animate by setting state — React re-renders smoothly
    setZoom(targetZoom);
    setPan({x:newPanX,y:newPanY});
  },[focusLat,focusLng,focusZoom]);
  const [dragging,setDragging]=useState(false);
  const dragRef=useRef(null);
  const svgRef=useRef(null);

  const doZoom=(factor)=>setZoom(z=>Math.max(0.8,Math.min(10,z*factor)));
  const doReset=()=>{setZoom(1);setPan({x:0,y:0});};

  // Touch support
  const touchRef=useRef(null);
  const onTouchStart=(e)=>{
    if(e.touches.length===1){
      setDragging(true);
      dragRef.current={sx:e.touches[0].clientX,sy:e.touches[0].clientY,px:pan.x,py:pan.y};
      touchRef.current={single:true};
    } else if(e.touches.length===2){
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      touchRef.current={pinchDist:Math.sqrt(dx*dx+dy*dy),zoom};
    }
  };
  const onTouchMove=(e)=>{
    e.preventDefault();
    if(e.touches.length===1&&dragging&&dragRef.current){
      setPan({x:dragRef.current.px+(e.touches[0].clientX-dragRef.current.sx),
              y:dragRef.current.py+(e.touches[0].clientY-dragRef.current.sy)});
    } else if(e.touches.length===2&&touchRef.current?.pinchDist){
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      const newDist=Math.sqrt(dx*dx+dy*dy);
      const factor=newDist/touchRef.current.pinchDist;
      setZoom(Math.max(0.8,Math.min(10,touchRef.current.zoom*factor)));
    }
  };
  const onMouseDown=(e)=>{
    setDragging(true);
    dragRef.current={sx:e.clientX,sy:e.clientY,px:pan.x,py:pan.y};
  };
  const onMouseMove=(e)=>{
    if(!dragging||!dragRef.current) return;
    setPan({x:dragRef.current.px+(e.clientX-dragRef.current.sx),
             y:dragRef.current.py+(e.clientY-dragRef.current.sy)});
  };
  const onMouseUp=()=>{setDragging(false);dragRef.current=null;};

  const onWheel=(e)=>{
    e.preventDefault();
    doZoom(e.deltaY<0?1.15:1/1.15);
  };

  const transform=`translate(${pan.x},${pan.y}) scale(${zoom})`;

  return(
    <div style={{position:"relative",borderRadius:12,overflow:"hidden",
      border:"1px solid "+C.border,background:"#E8EEF5",width:"100%",
      userSelect:"none",cursor:dragging?"grabbing":"grab"}}>

      <svg ref={svgRef}
        viewBox={"0 0 "+MAP_W+" "+MAP_H}
        preserveAspectRatio="xMidYMid meet"
        style={{display:"block",width:"100%",height:"auto"}}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={()=>{onMouseUp();setTip(null);setHovered(null);}}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onMouseUp}>

        <g transform={transform}>
          {INDIA_PATHS.map(s=>{
            const isSelected=s.n===selectedState;
            const isHovered=s.n===hovered;
            const col=stateColor(s.n);
            return(
              <path key={s.n}
                d={s.d}
                fill={col}
                fillOpacity={isSelected?1:isHovered?0.95:0.78}
                stroke="#fff"
                strokeWidth={isSelected?2.5/zoom:0.6/zoom}
                strokeLinejoin="round"
                style={{cursor:"pointer",transition:"fill-opacity 0.1s"}}
                onMouseEnter={(e)=>{
                  setHovered(s.n);
                  const r=svgRef.current.getBoundingClientRect();
                  const scaleX=MAP_W/r.width;
                  const scaleY=MAP_H/r.height;
                  setTip({name:s.n,score:STATE_GROWTH[s.n]||50,
                    x:(e.clientX-r.left)*scaleX,
                    y:(e.clientY-r.top)*scaleY});
                }}
                onMouseMove={(e)=>{
                  if(!svgRef.current) return;
                  const r=svgRef.current.getBoundingClientRect();
                  const scaleX=MAP_W/r.width;
                  const scaleY=MAP_H/r.height;
                  setTip(t=>t?{...t,x:(e.clientX-r.left)*scaleX,y:(e.clientY-r.top)*scaleY}:null);
                }}
                onMouseLeave={()=>{setHovered(null);setTip(null);}}
                onClick={(e)=>{e.stopPropagation();if(onStateClick)onStateClick(s.n);}}
              />
            );
          })}

          {/* State name labels — fixed SVG size, zoom transform handles scaling */}
          {INDIA_PATHS.map(s=>{
            const sc=STATE_GROWTH[s.n]||50;
            // Abbreviated names for small states
            const SHORT={
              "Jammu and Kashmir":"J&K",
              "Himachal Pradesh":"H.P.",
              "Uttaranchal":"Uttarakhand",
              "Arunachal Pradesh":"Arunachal",
              "Andaman and Nicobar":"A&N",
              "Dadra and Nagar Haveli":"DNH",
              "Daman and Diu":"D&D",
              "Lakshadweep":"Lkshd.",
              "Chandigarh":"CHD",
              "Puducherry":"Pondy",
            };
            // At zoom<1.5 show short names, at zoom>=1.5 show full names
            const label = zoom >= 1.8 ? s.n : (SHORT[s.n] || s.n);
            // Font size in SVG units — stays consistent as zoom scales everything
            // Larger states get bigger font, small states get smaller
            const baseFontSize = 6; // SVG units — will be magnified by zoom transform
            // Opacity: fully visible at zoom>=1, fade out below 1
            const opacity = Math.min(1, Math.max(0, (zoom - 0.85) / 0.3));
            // Text color for contrast against state fill
            const textCol = sc>=65 ? "#fff" : "#0F1B2D";
            const haloCol = sc>=65 ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.85)";
            return(
              <text
                key={"lbl-"+s.n}
                x={s.cx}
                y={s.cy}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={baseFontSize}
                fontWeight="700"
                fontFamily="Inter, Arial, sans-serif"
                fill={textCol}
                stroke={haloCol}
                strokeWidth={1.8}
                paintOrder="stroke fill"
                pointerEvents="none"
                opacity={opacity}
                style={{userSelect:"none"}}
              >
                {label}
              </text>
            );
          })}


          {/* Regional Clusters — drill-down when zoomed in past state level */}
          {zoom >= 2.2 && (()=>{
            // Find which state's centroid is nearest the current viewport center
            const viewCenterX = (MAP_W/2 - pan.x) / zoom;
            const viewCenterY = (MAP_H/2 - pan.y) / zoom;
            let nearestState = null, minDist = Infinity;
            INDIA_PATHS.forEach(s => {
              const d = Math.hypot(s.cx - viewCenterX, s.cy - viewCenterY);
              if (d < minDist) { minDist = d; nearestState = s.n; }
            });
            const regions = getRegionsForState(nearestState);
            if (regions.length === 0) return null;
            return regions.map(r => {
              const [rx, ry] = lngLatToSVG(r.lng, r.lat);
              const col = scoreColor(r.score);
              return (
                <g key={"region-"+r.name} transform={"translate("+rx+","+ry+")"}
                  style={{cursor:"pointer"}}
                  onClick={(e)=>{e.stopPropagation(); if(onStateClick) onStateClick(r.name.split(" (")[0]);}}
                  onMouseEnter={(e)=>{
                    if(!svgRef.current) return;
                    const rect=svgRef.current.getBoundingClientRect();
                    const scaleX=MAP_W/rect.width, scaleY=MAP_H/rect.height;
                    setTip({name:r.name, score:r.score,
                      x:(e.clientX-rect.left)*scaleX, y:(e.clientY-rect.top)*scaleY, isRegion:true});
                  }}
                  onMouseLeave={()=>setTip(null)}>
                  <circle r={5/zoom} fill={col} stroke="#fff" strokeWidth={1.2/zoom} fillOpacity={0.9}/>
                  <text x={0} y={-8/zoom} textAnchor="middle"
                    fontSize={5.5} fontWeight="600" fontFamily="Inter, sans-serif"
                    fill={C.dark} stroke="#fff" strokeWidth={2} paintOrder="stroke fill"
                    pointerEvents="none">
                    {r.name.split(" (")[0]}
                  </text>
                </g>
              );
            });
          })()}

          {/* Pins */}
          {pins.map((p,i)=>{
            if(!p.lat||!p.lng) return null;
            const [px,py]=lngLatToSVG(p.lng,p.lat);
            const col=scoreColor(p.growth_score||60);
            return(
              <g key={i} transform={"translate("+px+","+py+")"}
                style={{cursor:"pointer"}}
                onMouseEnter={(e)=>{
                  if(!svgRef.current) return;
                  const r=svgRef.current.getBoundingClientRect();
                  const scaleX=MAP_W/r.width;
                  const scaleY=MAP_H/r.height;
                  setTip({name:p.location||p.location_name,score:p.growth_score,
                    cagr:p.expected_cagr,price:p.current_price_sqft,
                    reco:p.recommendation,thesis:p.one_line_thesis,
                    x:(e.clientX-r.left)*scaleX,y:(e.clientY-r.top)*scaleY,isPin:true});
                }}
                onMouseLeave={()=>setTip(null)}>
                <circle r={14/zoom} fill={col} fillOpacity={0.2}/>
                <circle r={8/zoom} fill={col} stroke="#fff" strokeWidth={2/zoom}/>
                <text textAnchor="middle" dy="0.36em"
                  fontSize={7/zoom} fontWeight="700" fill="#fff" fontFamily="Inter,sans-serif">
                  {p.growth_score||"?"}
                </text>
              </g>
            );
          })}
        </g>

        {/* Tooltip rendered in SVG coordinate space */}
        {tip&&(()=>{
          const tx=Math.min(tip.x+14,MAP_W-230);
          const ty=Math.max(tip.y-100,4);
          const sc=tip.score||50;
          const col=scoreColor(sc);
          return(
            <g style={{pointerEvents:"none"}} transform={"translate("+tx+","+ty+")"}>
              <rect width={220} height={tip.thesis?90:tip.cagr?70:52}
                rx={8} fill="white" stroke={C.border} strokeWidth={1}
                filter="url(#shadow)"/>
              <text x={10} y={18} fontSize={12} fontWeight="700"
                fill={C.dark} fontFamily="Inter,sans-serif">{tip.name}</text>
              <rect x={10} y={26} width={50} height={18} rx={4} fill={col}/>
              <text x={35} y={38} textAnchor="middle" fontSize={10}
                fontWeight="700" fill="white" fontFamily="Inter,sans-serif">
                Score {sc}
              </text>
              {tip.cagr&&<>
                <rect x={66} y={26} width={60} height={18} rx={4} fill="#EFF6FF"/>
                <text x={96} y={38} textAnchor="middle" fontSize={10}
                  fontWeight="600" fill={C.blue} fontFamily="Inter,sans-serif">
                  {tip.cagr}
                </text>
              </>}
              {tip.price&&<text x={10} y={54} fontSize={10} fill={C.muted}
                fontFamily="Inter,sans-serif">{tip.price}</text>}
              {tip.thesis&&<text x={10} y={tip.price?68:54} fontSize={9} fill={C.muted}
                fontFamily="Inter,sans-serif" fontStyle="italic">{tip.thesis.slice(0,45)}…</text>}
              {!tip.isPin&&<text x={10} y={tip.price?68:54} fontSize={9}
                fill={C.blue} fontFamily="Inter,sans-serif" fontWeight="500">
                Click to analyze →
              </text>}
            </g>
          );
        })()}

        {/* Drop shadow filter */}
        <defs>
          <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.12"/>
          </filter>
        </defs>
      </svg>

      {/* Zoom controls */}
      <div style={{position:"absolute",top:10,right:10,
        display:"flex",flexDirection:"column",gap:4,zIndex:20}}>
        {[["＋",()=>doZoom(1.5)],["－",()=>doZoom(1/1.5)],["⊙",doReset]].map(([lbl,fn])=>(
          <button key={lbl} onClick={fn}
            style={{width:32,height:32,background:"rgba(255,255,255,0.97)",
              border:"1px solid "+C.border,borderRadius:7,cursor:"pointer",
              fontFamily:"Inter,sans-serif",fontWeight:700,
              fontSize:lbl==="⊙"?12:18,color:C.dark,
              display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:"0 1px 4px rgba(0,0,0,0.12)"}}>
            {lbl}
          </button>
        ))}
      </div>

      {/* Legend — collapsed by default on mobile so it doesn't cover the southern states */}
      <div style={{position:"absolute",bottom:8,left:8,zIndex:20}}>
        {legendOpen ? (
          <div onClick={()=>setLegendOpen(false)} style={{cursor:"pointer",
            background:"rgba(255,255,255,0.96)",borderRadius:7,
            padding:"5px 9px",fontFamily:"Inter,sans-serif",fontSize:10,
            display:"flex",flexDirection:"column",gap:3,
            border:"1px solid "+C.border}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:1}}>
              <span style={{fontWeight:600,color:C.muted,fontSize:9}}>LEGEND</span>
              <span style={{color:C.muted,fontSize:11}}>✕</span>
            </div>
            {[{c:ZC.mega,l:"Mega Growth (90+)"},{c:ZC.hot,l:"Emerging Hot (80–89)"},
              {c:ZC.growth,l:"Growth Zone (65–79)"},{c:ZC.stable,l:"Stable (50–64)"},
              {c:ZC.low,l:"High Risk (<50)"}
            ].map(x=>(
              <div key={x.l} style={{display:"flex",alignItems:"center",gap:5}}>
                <div style={{width:10,height:10,borderRadius:2,background:x.c,opacity:0.9}}/>
                <span style={{color:C.dark}}>{x.l}</span>
              </div>
            ))}
          </div>
        ) : (
          <button onClick={()=>setLegendOpen(true)} style={{
            background:"rgba(255,255,255,0.96)",border:"1px solid "+C.border,borderRadius:7,
            padding:"5px 9px",fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:600,
            color:C.muted,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
            <span style={{width:8,height:8,borderRadius:2,background:ZC.mega,display:"inline-block"}}/>
            Legend
          </button>
        )}
      </div>
    </div>
  );
}


// ── MapView — picks Google Maps (if API key configured) or the built-in SVG map ──
// GoogleMapView is a static import (works fine in the Vite/Vercel build whether
// or not a key is set — it just won't render anything without one). The Claude.ai
// artifact preview doesn't include this file at all, so MapView here simply
// renders IndiaMap directly in that environment (see notes in DEPLOY.md).
function MapView(props) {
  const apiKey = typeof import.meta !== "undefined" ? import.meta.env?.VITE_GOOGLE_MAPS_API_KEY : null;
  const [useGoogle, setUseGoogle] = useState(!!apiKey);
  const mapProps = { stateGrowth: STATE_GROWTH, regionClusters: REGION_CLUSTERS, ...props };
  if (!apiKey) return <IndiaMap {...props} />;
  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", top: 10, left: 10, zIndex: 30, display: "flex", gap: 4 }}>
        {[["🗺️ Live Map", true], ["📍 Quick View", false]].map(([label, val]) => (
          <button key={label} onClick={() => setUseGoogle(val)}
            style={{ background: useGoogle === val ? C.navy : "rgba(255,255,255,0.95)",
              color: useGoogle === val ? "#fff" : C.muted,
              border: "1px solid " + (useGoogle === val ? C.navy : C.border),
              borderRadius: 16, padding: "5px 11px", fontFamily: "Inter,sans-serif",
              fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
            {label}
          </button>
        ))}
      </div>
      {useGoogle ? <GoogleMapView {...mapProps} /> : <IndiaMap {...props} />}
    </div>
  );
}


function Ring({score,label,size=72}){
  const [a,setA]=useState(0);
  const r=(size-12)/2,circ=2*Math.PI*r,col=scoreColor(a);
  useEffect(()=>{
    let st=null;
    const go=(ts)=>{if(!st)st=ts;const p=Math.min((ts-st)/900,1);setA(Math.round((1-Math.pow(1-p,3))*(score||0)));if(p<1)requestAnimationFrame(go);};
    const id=requestAnimationFrame(go);return()=>cancelAnimationFrame(id);
  },[score]);
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={7}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={7}
          strokeDasharray={circ} strokeDashoffset={circ-(a/100)*circ}
          strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} style={{transition:"stroke 0.3s"}}/>
        <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fontSize={13} fontWeight="700" fill={col} fontFamily="Inter,sans-serif">{a}</text>
      </svg>
      <span style={{fontSize:10,color:C.muted,textAlign:"center",fontFamily:"Inter,sans-serif",lineHeight:1.2,maxWidth:size+6}}>{label}</span>
    </div>
  );
}

const SINFO=[
  {l:"Infrastructure Impact",w:"25%",c:"#2563EB",d:"Bharatmala highways, expressways, DFCs, metro lines, airports, industrial corridors, PM Gati Shakti."},
  {l:"Population Growth",w:"20%",c:"#0891B2",d:"Census trends, urbanization rate, migration patterns, household formation, schools & hospitals."},
  {l:"Economic Activity",w:"20%",c:"#7C3AED",d:"New factories, GCC/IT expansion, warehousing demand, tourism, hospitality, government capex."},
  {l:"Connectivity",w:"15%",c:"#1E6B4A",d:"Travel time to highway, expressway, airport, metro, railway, industrial corridor, tier-1 city."},
  {l:"Urban Expansion",w:"10%",c:"#D97706",d:"Satellite-tracked built-up area growth, new roads, land conversion from agricultural use."},
  {l:"Market Momentum",w:"5%",c:"#C84B31",d:"Historical price appreciation, transaction volumes, building permits, layout approvals."},
  {l:"Scarcity",w:"5%",c:"#64748B",d:"Developable land availability, agricultural conversion constraints, supply vs demand pipeline."},
];
function ScoreModal({onClose}){
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,27,45,0.6)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:460,width:"100%",maxHeight:"80vh",overflowY:"auto",boxShadow:"0 24px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        <div style={{background:C.navy,padding:"15px 20px",borderRadius:"14px 14px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{color:"#F8FAFB",fontFamily:"serif",fontSize:16}}>How Scores Are Calculated</div>
            <div style={{color:"#94A3B8",fontFamily:"Inter,sans-serif",fontSize:11,marginTop:2}}>Weighted average of 7 intelligence dimensions</div>
          </div>
          <button onClick={onClose} style={{background:"#1E293B",border:"none",color:"#94A3B8",borderRadius:6,width:28,height:28,cursor:"pointer",fontWeight:700,fontSize:14}}>✕</button>
        </div>
        <div style={{padding:"14px 20px 20px"}}>
          <div style={{background:C.bg,borderRadius:8,padding:"10px 12px",marginBottom:12,fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,lineHeight:1.6}}>
            <strong>Formula:</strong> Growth Score = (Infra×0.25)+(Pop×0.20)+(Econ×0.20)+(Conn×0.15)+(Urban×0.10)+(Mom×0.05)+(Scarcity×0.05)
          </div>
          {SINFO.map((s,i)=>(
            <div key={i} style={{borderBottom:i<SINFO.length-1?`1px solid ${C.border}`:"none",padding:"9px 0"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:s.c}}>{s.l}</div>
                <div style={{background:s.c+"18",color:s.c,borderRadius:20,padding:"2px 8px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:11}}>{s.w}</div>
              </div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,lineHeight:1.5}}>{s.d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewsSignals({signals}){
  if(!signals||!signals.length) return null;
  const st=(t)=>{
    if(t==="BULLISH")  return{bg:"#F0FDF4",br:"#86EFAC",tx:C.green,ic:"📈"};
    if(t==="BEARISH")  return{bg:"#FFF5F5",br:"#FCA5A5",tx:C.red,ic:"📉"};
    if(t==="CATALYST") return{bg:"#FFFBEB",br:"#FDE68A",tx:"#92400E",ic:"⚡"};
    return{bg:C.lightBlue,br:"#BFDBFE",tx:C.blue,ic:"📰"};
  };
  return(
    <div style={{background:"#fff",borderRadius:12,border:`1px solid ${C.border}`,padding:"15px"}}>
      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
        🗞️ Intelligence Signals <span style={{background:C.lightBlue,color:C.blue,borderRadius:20,padding:"2px 8px",fontSize:10,fontWeight:600}}>Live</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {signals.map((s,i)=>{const x=st(s.type);return(
          <div key={i} style={{background:x.bg,border:`1px solid ${x.br}`,borderRadius:8,padding:"9px 11px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:6}}>
              <div style={{display:"flex",gap:6,alignItems:"flex-start"}}>
                <span style={{fontSize:13,flexShrink:0}}>{x.ic}</span>
                <div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark,lineHeight:1.4}}>{s.headline}</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,marginTop:2,lineHeight:1.5}}>{s.impact}</div>
                </div>
              </div>
              <div style={{background:x.tx+"18",color:x.tx,borderRadius:5,padding:"2px 6px",fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>{s.type}</div>
            </div>
            {s.price_impact&&<div style={{marginTop:4,fontFamily:"Inter,sans-serif",fontSize:11,color:x.tx,fontWeight:600,borderTop:`1px solid ${x.br}`,paddingTop:4}}>Price impact: {s.price_impact}</div>}
          </div>
        );})}
      </div>
    </div>
  );
}

function Sentiment({score,label}){
  if(!score) return null;
  const pct=Math.max(0,Math.min(100,score));
  const col=pct>=70?C.green:pct>=50?C.amber:C.red;
  return(
    <div style={{background:"#fff",borderRadius:10,border:`1px solid ${C.border}`,padding:"12px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark}}>Market Sentiment</div>
        <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:700,color:col}}>{pct>=70?"Bullish 🟢":pct>=50?"Neutral 🟡":"Bearish 🔴"}</div>
      </div>
      <div style={{background:C.border,borderRadius:99,height:7,overflow:"hidden"}}>
        <div style={{background:col,height:"100%",width:`${pct}%`,borderRadius:99,transition:"width 1s ease"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:3,fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted}}>
        <span>Bearish</span><span>Neutral</span><span>Bullish</span>
      </div>
      {label&&<div style={{marginTop:6,fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,lineHeight:1.5}}>{label}</div>}
    </div>
  );
}


// ── Data Provenance Badge — tells the user where a number actually came from ──
function ProvenanceBadge({type}){
  const cfg = {
    cited: {bg:"#F0FDF4", border:"#86EFAC", color:"#15803D", icon:"📄", label:"Cited public document"},
    curated: {bg:"#EFF6FF", border:"#BFDBFE", color:"#1D4ED8", icon:"📋", label:"Curated reference data"},
    ai: {bg:"#FFFBEB", border:"#FDE68A", color:"#92400E", icon:"✨", label:"AI estimation"},
  }[type] || {bg:"#F1F5F9", border:"#E2E8F0", color:C.muted, icon:"?", label:"Unknown source"};
  return(
    <span style={{display:"inline-flex",alignItems:"center",gap:4,background:cfg.bg,
      border:"1px solid "+cfg.border,color:cfg.color,borderRadius:12,padding:"2px 8px",
      fontFamily:"Inter,sans-serif",fontSize:9,fontWeight:600,whiteSpace:"nowrap"}}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ── Karnataka Infrastructure Pipeline Card — only renders for Karnataka
// localities, since this is the only state with curated, cited data so far.
// ── Metro & Rail Connectivity Card ──────────────────────────────────────────
// Searches for real nearby transit stations using two methods:
// 1. Google Maps Places API (if VITE_GOOGLE_MAPS_API_KEY is set and places
//    library is loaded) — most complete, real-time station data
// 2. OpenStreetMap Overpass API — free, no key needed, works everywhere,
//    slightly less complete for newer stations
// This ensures the card works in both Google Maps and SVG map mode.
// ── INDIA_METRO_STATIONS — curated static dataset ──────────────────────────
// Covers all operationally confirmed metro networks as of mid-2026.
// Sources: BMRCL, DMRC, HMRL, CMRL, KMRL, Wikipedia, themetrorailguy.com
// Each station: {n: name, la: lat, lo: lng, ln: line, st: status, c: city}
// status: "op" = operational | "uc" = under construction | "pr" = proposed
// Compact keys to keep bundle size manageable (this is ~600 stations).
// INDIA_METRO_STATIONS — seed data embedded here, upgraded at runtime
// from /data/metro_stations_flat.json (ETL output) via useAppData() below.
let INDIA_METRO_STATIONS = [

// ── BENGALURU — Namma Metro (86 operational as of Aug 2025) ─────────────────
// Purple Line (Whitefield–Challaghatta, 38 stations)
{n:"Whitefield (Kadugodi)",     la:12.9882, lo:77.7500, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Channasandra",              la:12.9943, lo:77.7171, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Kadugodi Tree Park",        la:12.9921, lo:77.7042, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Hopefarm Channasandra",     la:12.9885, lo:77.6927, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Kundalahalli",              la:12.9842, lo:77.6826, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Brookefield",               la:12.9815, lo:77.6717, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Tin Factory",               la:12.9780, lo:77.6646, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Krishnarajapura",           la:13.0022, lo:77.6944, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Benniganahalli",            la:12.9916, lo:77.6547, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Baiyappanahalli",           la:12.9948, lo:77.6470, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Swami Vivekananda Road",    la:12.9895, lo:77.6403, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Indiranagar",               la:12.9784, lo:77.6408, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Halasuru",                  la:12.9763, lo:77.6259, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Trinity",                   la:12.9698, lo:77.6204, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"MG Road",                   la:12.9756, lo:77.6101, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Cubbon Park",               la:12.9789, lo:77.5949, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Vidhana Soudha",            la:12.9788, lo:77.5905, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Sir M Visveshwaraya",       la:12.9759, lo:77.5796, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Nadaprabhu Kempegowda (Majestic)", la:12.9767, lo:77.5713, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"City Railway Station",      la:12.9774, lo:77.5640, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Magadi Road",               la:12.9755, lo:77.5570, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Hosahalli",                 la:12.9701, lo:77.5462, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Vijayanagar",               la:12.9669, lo:77.5373, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Attiguppe",                 la:12.9563, lo:77.5341, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Deepanjali Nagar",          la:12.9468, lo:77.5312, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Mysore Road",               la:12.9431, lo:77.5233, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Pantharapalya",             la:12.9354, lo:77.5183, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Nayandahalli",              la:12.9294, lo:77.5098, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Rajarajeshwari Nagar",      la:12.9180, lo:77.5022, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Jnanabharathi",             la:12.9117, lo:77.5001, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Pattanagere",               la:12.9049, lo:77.4960, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Kengeri Bus Terminal",      la:12.9004, lo:77.4872, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Kengeri",                   la:12.8972, lo:77.4827, ln:"Purple", st:"op", c:"Bengaluru"},
{n:"Challaghatta",              la:12.8927, lo:77.4769, ln:"Purple", st:"op", c:"Bengaluru"},
// Green Line (Madavara–Silk Institute, 32 stations)
{n:"Madavara",                  la:13.0938, lo:77.5003, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Chikkabidarakallu",         la:13.0793, lo:77.5052, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Manjunathanagar",           la:13.0653, lo:77.5110, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Nagasandra",                la:13.0496, lo:77.5173, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Dasarahalli",               la:13.0393, lo:77.5226, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Jalahalli",                 la:13.0290, lo:77.5289, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Peenya Industry",           la:13.0227, lo:77.5370, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Peenya",                    la:13.0165, lo:77.5432, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Goraguntepalya",            la:13.0094, lo:77.5495, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Yeshwanthpur",              la:13.0271, lo:77.5551, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Sandal Soap Factory",       la:13.0211, lo:77.5618, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Mahalakshmi",               la:13.0133, lo:77.5679, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Rajajinagar",               la:13.0042, lo:77.5665, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Mahakavi Kuvempu Road",     la:12.9979, lo:77.5696, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Srirampura",                la:12.9904, lo:77.5706, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Mantri Square Sampige Road",la:12.9862, lo:77.5733, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Nadaprabhu Kempegowda (Majestic)", la:12.9767, lo:77.5713, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Chickpete",                 la:12.9659, lo:77.5762, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Krishna Rajendra Market",   la:12.9606, lo:77.5779, ln:"Green", st:"op", c:"Bengaluru"},
{n:"National College",          la:12.9537, lo:77.5779, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Lalbagh",                   la:12.9509, lo:77.5816, ln:"Green", st:"op", c:"Bengaluru"},
{n:"South End Circle",          la:12.9454, lo:77.5854, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Jayanagar",                 la:12.9304, lo:77.5845, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Rashtreeya Vidyalaya Road", la:12.9226, lo:77.5922, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Banashankari",              la:12.9137, lo:77.5792, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Jaya Prakash Nagar",        la:12.9097, lo:77.5846, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Puttenahalli",              la:12.9032, lo:77.5895, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Yelachenahalli",            la:12.8961, lo:77.5948, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Konanakunte Cross",         la:12.8862, lo:77.5962, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Doddakallasandra",          la:12.8787, lo:77.5976, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Vajarahalli",               la:12.8694, lo:77.5989, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Talaghattapura",            la:12.8582, lo:77.5943, ln:"Green", st:"op", c:"Bengaluru"},
{n:"Silk Institute",            la:12.8469, lo:77.5812, ln:"Green", st:"op", c:"Bengaluru"},
// Yellow Line — 16 stations, operational since 10 Aug 2025
// Source: Wikipedia "Yellow Line (Namma Metro)", BMRCL official, bengalurumetro.in
// Exact order: RV Road → Bommasandra (south)
{n:"Rashtreeya Vidyalaya Road",           la:12.9226, lo:77.5922, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Ragigudda",                           la:12.9090, lo:77.6010, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Jayadeva Hospital",                   la:12.9006, lo:77.6105, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"BTM Layout",                          la:12.8942, lo:77.6148, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Central Silk Board",                  la:12.9172, lo:77.6220, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Hongasandra",                         la:12.8840, lo:77.6298, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Kudlu Gate",                          la:12.8752, lo:77.6390, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Singasandra",                         la:12.8661, lo:77.6482, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Hosa Road",                           la:12.8558, lo:77.6580, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Electronic City",                     la:12.8399, lo:77.6745, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Infosys Foundation Konappana Agrahara",la:12.8326, lo:77.6815, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Beratena Agrahara",                   la:12.8264, lo:77.6891, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Hebbagodi",                           la:12.8170, lo:77.6920, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Huskur Road",                         la:12.8081, lo:77.6941, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Bommasandra",                         la:12.7951, lo:77.6932, ln:"Yellow", st:"op", c:"Bengaluru"},
{n:"Delta Electronics Bommasandra",       la:12.7832, lo:77.6912, ln:"Yellow", st:"op", c:"Bengaluru"},

// ── DELHI — DMRC (12 lines, 286 stations) — key stations ───────────────────
{n:"Rajiv Chowk",               la:28.6328, lo:77.2197, ln:"Yellow/Blue", st:"op", c:"Delhi"},
{n:"Kashmere Gate",             la:28.6677, lo:77.2285, ln:"Red/Yellow/Violet", st:"op", c:"Delhi"},
{n:"Central Secretariat",       la:28.6148, lo:77.2122, ln:"Yellow/Violet", st:"op", c:"Delhi"},
{n:"New Delhi",                 la:28.6435, lo:77.2193, ln:"Yellow/Airport", st:"op", c:"Delhi"},
{n:"Dwarka Sector 21",          la:28.5526, lo:77.0593, ln:"Blue/Airport", st:"op", c:"Delhi"},
{n:"Noida City Centre",         la:28.5706, lo:77.3588, ln:"Blue", st:"op", c:"Delhi"},
{n:"Botanical Garden",          la:28.5637, lo:77.3370, ln:"Blue/Aqua", st:"op", c:"Delhi"},
{n:"Hauz Khas",                 la:28.5432, lo:77.2066, ln:"Yellow/Magenta", st:"op", c:"Delhi"},
{n:"IGI Airport T3",            la:28.5565, lo:77.0882, ln:"Orange (Airport)", st:"op", c:"Delhi"},
{n:"Inderlok",                  la:28.6715, lo:77.1665, ln:"Green/Red", st:"op", c:"Delhi"},
{n:"Janakpuri West",            la:28.6262, lo:77.0855, ln:"Blue/Green", st:"op", c:"Delhi"},
{n:"Lajpat Nagar",              la:28.5677, lo:77.2394, ln:"Pink/Violet", st:"op", c:"Delhi"},
{n:"Nehru Place",               la:28.5484, lo:77.2518, ln:"Violet", st:"op", c:"Delhi"},
{n:"Gurugram Huda City Centre", la:28.4592, lo:77.0671, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Faridabad Old",             la:28.4089, lo:77.3152, ln:"Violet", st:"op", c:"Delhi"},
{n:"Ghaziabad Vaishali",        la:28.6489, lo:77.3600, ln:"Blue", st:"op", c:"Delhi"},
{n:"Gurgaon Sikanderpur",       la:28.4794, lo:77.0906, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Okhla Bird Sanctuary",      la:28.5350, lo:77.3057, ln:"Aqua", st:"op", c:"Delhi"},
{n:"Janpath",                   la:28.6267, lo:77.2207, ln:"Blue", st:"op", c:"Delhi"},
{n:"Saket",                     la:28.5245, lo:77.2107, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Connaught Place (Rajiv Chowk)", la:28.6328, lo:77.2197, ln:"Yellow/Blue", st:"op", c:"Delhi"},
{n:"Mayur Vihar Phase 1",       la:28.6082, lo:77.2968, ln:"Blue/Pink", st:"op", c:"Delhi"},
{n:"Rohini East",               la:28.7234, lo:77.1269, ln:"Red", st:"op", c:"Delhi"},
{n:"Samaypur Badali",           la:28.7327, lo:77.1554, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Welcome",                   la:28.6777, lo:77.2877, ln:"Red/Pink", st:"op", c:"Delhi"},
{n:"Anand Vihar ISBT",          la:28.6468, lo:77.3158, ln:"Blue/Pink", st:"op", c:"Delhi"},

// ── MUMBAI — Mumbai Metro (Lines 1, 2A, 7, partial others) ─────────────────
{n:"Versova",                   la:19.1313, lo:72.8164, ln:"Line 1", st:"op", c:"Mumbai"},
{n:"Andheri",                   la:19.1197, lo:72.8487, ln:"Line 1", st:"op", c:"Mumbai"},
{n:"Ghatkopar",                 la:19.0864, lo:72.9074, ln:"Line 1", st:"op", c:"Mumbai"},
{n:"D N Nagar",                 la:19.1189, lo:72.8381, ln:"Line 2A", st:"op", c:"Mumbai"},
{n:"Dahisar East",              la:19.2420, lo:72.8670, ln:"Line 2A/7", st:"op", c:"Mumbai"},
{n:"Aarey",                     la:19.1640, lo:72.8636, ln:"Line 1 extension", st:"op", c:"Mumbai"},
{n:"Goregaon East",             la:19.1567, lo:72.8701, ln:"Line 7", st:"op", c:"Mumbai"},
{n:"Gundavali",                 la:19.1329, lo:72.8631, ln:"Line 7", st:"op", c:"Mumbai"},
{n:"Charkop",                   la:19.1925, lo:72.8380, ln:"Line 2A", st:"op", c:"Mumbai"},
{n:"Borivali West",             la:19.2310, lo:72.8529, ln:"Line 2A", st:"op", c:"Mumbai"},
{n:"Bandra-Kurla Complex",      la:19.0645, lo:72.8693, ln:"Line 2B (partial)", st:"uc", c:"Mumbai"},
{n:"CSIA International Airport",la:19.0896, lo:72.8656, ln:"Line 2B (partial)", st:"uc", c:"Mumbai"},,

// Delhi — 137 stations from Wikipedia-parsed coordinates (dhirajt/delhi-metro-stations)
{n:"Adarsh Nagar", la:28.71642, lo:77.17046, ln:"Yellow", st:"op", c:"Delhi"},
{n:"AIIMS", la:28.56892, lo:77.20771, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Akshardham", la:28.61806, lo:77.27869, ln:"Blue", st:"op", c:"Delhi"},
{n:"Anand Vihar", la:28.64695, lo:77.31603, ln:"Blue", st:"op", c:"Delhi"},
{n:"Arjan Garh", la:28.48076, lo:77.12583, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Ashok Park Main", la:28.67153, lo:77.15527, ln:"Green", st:"op", c:"Delhi"},
{n:"Azadpur", la:28.70696, lo:77.18053, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Badarpur", la:28.49334, lo:77.30307, ln:"Violet", st:"op", c:"Delhi"},
{n:"Barakhambha Road", la:28.63003, lo:77.22436, ln:"Blue", st:"op", c:"Delhi"},
{n:"Botanical Garden", la:28.56409, lo:77.3342, ln:"Blue", st:"op", c:"Delhi"},
{n:"Central Secretariat", la:28.61474, lo:77.21191, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Chandni Chowk", la:28.65785, lo:77.23014, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Chhatarpur", la:28.50671, lo:77.17484, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Chawri Bazar", la:28.64931, lo:77.22637, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Civil Lines", la:28.67726, lo:77.2241, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Delhi Aerocity", la:28.54881, lo:77.12092, ln:"Orange(Airport)", st:"op", c:"Delhi"},
{n:"Dhaula Kuan", la:28.59178, lo:77.16155, ln:"Orange(Airport)", st:"op", c:"Delhi"},
{n:"Dilshad Garden", la:28.67592, lo:77.32142, ln:"Red", st:"op", c:"Delhi"},
{n:"Dwarka", la:28.61564, lo:77.02197, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Morh", la:28.61932, lo:77.03326, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 10", la:28.58068, lo:77.05682, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 11", la:28.58657, lo:77.04929, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 12", la:28.59232, lo:77.04051, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 13", la:28.59722, lo:77.03326, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 14", la:28.60223, lo:77.02588, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 21", la:28.55226, lo:77.05828, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 8", la:28.56583, lo:77.06706, ln:"Blue", st:"op", c:"Delhi"},
{n:"Dwarka Sector 9", la:28.57487, lo:77.06454, ln:"Blue", st:"op", c:"Delhi"},
{n:"Ghitorni", la:28.49383, lo:77.14922, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Govind Puri", la:28.54451, lo:77.26401, ln:"Violet", st:"op", c:"Delhi"},
{n:"Green Park", la:28.55979, lo:77.20682, ln:"Yellow", st:"op", c:"Delhi"},
{n:"GTB Nagar", la:28.69785, lo:77.20722, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Guru Dronacharya", la:28.48203, lo:77.10232, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Hauz Khas", la:28.54335, lo:77.20667, ln:"Yellow", st:"op", c:"Delhi"},
{n:"HUDA City Centre", la:28.45927, lo:77.07268, ln:"Yellow", st:"op", c:"Delhi"},
{n:"IFFCO Chowk", la:28.47209, lo:77.07175, ln:"Yellow", st:"op", c:"Delhi"},
{n:"INA", la:28.57526, lo:77.20935, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Inderlok", la:28.67319, lo:77.16994, ln:"Red", st:"op", c:"Delhi"},
{n:"Indira Gandhi International Airport", la:28.55693, lo:77.08669, ln:"Orange(Airport)", st:"op", c:"Delhi"},
{n:"Indraprastha", la:28.62051, lo:77.24993, ln:"Blue", st:"op", c:"Delhi"},
{n:"Jahangirpuri", la:28.72592, lo:77.16267, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Janakpuri East", la:28.63305, lo:77.08669, ln:"Blue", st:"op", c:"Delhi"},
{n:"Janakpuri West", la:28.62943, lo:77.07767, ln:"Blue", st:"op", c:"Delhi"},
{n:"Jangpura", la:28.5843, lo:77.23766, ln:"Violet", st:"op", c:"Delhi"},
{n:"Jasola Apollo", la:28.53824, lo:77.28319, ln:"Violet", st:"op", c:"Delhi"},
{n:"Jawaharlal Nehru Stadium", la:28.5904, lo:77.23326, ln:"Violet", st:"op", c:"Delhi"},
{n:"Jhandewalan", la:28.64427, lo:77.19988, ln:"Blue", st:"op", c:"Delhi"},
{n:"Jhilmil", la:28.67579, lo:77.31239, ln:"Red", st:"op", c:"Delhi"},
{n:"Jor Bagh", la:28.58708, lo:77.21209, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Kailash Colony", la:28.55527, lo:77.24205, ln:"Violet", st:"op", c:"Delhi"},
{n:"Kalkaji Mandir", la:28.55007, lo:77.25835, ln:"Violet", st:"op", c:"Delhi"},
{n:"Kanhiya Nagar", la:28.68254, lo:77.16459, ln:"Red", st:"op", c:"Delhi"},
{n:"Karkarduma", la:28.64849, lo:77.30558, ln:"Blue", st:"op", c:"Delhi"},
{n:"Karol Bagh", la:28.644, lo:77.18855, ln:"Blue", st:"op", c:"Delhi"},
{n:"Kashmere Gate", la:28.6675, lo:77.22817, ln:"Red", st:"op", c:"Delhi"},
{n:"Kaushambi", la:28.64544, lo:77.32432, ln:"Blue", st:"op", c:"Delhi"},
{n:"Keshav Puram", la:28.68894, lo:77.1616, ln:"Red", st:"op", c:"Delhi"},
{n:"Khan Market", la:28.60276, lo:77.22829, ln:"Violet", st:"op", c:"Delhi"},
{n:"Kirti Nagar", la:28.65575, lo:77.15057, ln:"Blue", st:"op", c:"Delhi"},
{n:"Kohat Enclave", la:28.6981, lo:77.14024, ln:"Red", st:"op", c:"Delhi"},
{n:"Lajpat Nagar", la:28.57079, lo:77.23653, ln:"Violet", st:"op", c:"Delhi"},
{n:"Laxmi Nagar", la:28.63064, lo:77.27749, ln:"Blue", st:"op", c:"Delhi"},
{n:"Madipur", la:28.67734, lo:77.11965, ln:"Green", st:"op", c:"Delhi"},
{n:"Malviya Nagar", la:28.52798, lo:77.20565, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Mandi House", la:28.62588, lo:77.2341, ln:"Blue", st:"op", c:"Delhi"},
{n:"Mansarovar Park", la:28.67544, lo:77.30095, ln:"Red", st:"op", c:"Delhi"},
{n:"Mayur Vihar -I", la:28.60442, lo:77.28925, ln:"Blue", st:"op", c:"Delhi"},
{n:"Mayur Vihar Extension", la:28.59428, lo:77.29455, ln:"Blue", st:"op", c:"Delhi"},
{n:"MG Road", la:28.47957, lo:77.08006, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Model Town", la:28.70278, lo:77.19363, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Mohan Estate", la:28.51938, lo:77.29388, ln:"Violet", st:"op", c:"Delhi"},
{n:"Moolchand", la:28.56417, lo:77.23423, ln:"Violet", st:"op", c:"Delhi"},
{n:"Moti Nagar", la:28.65784, lo:77.14248, ln:"Blue", st:"op", c:"Delhi"},
{n:"Mundka", la:28.68321, lo:77.03133, ln:"Green", st:"op", c:"Delhi"},
{n:"Nangloi", la:28.68231, lo:77.06471, ln:"Green", st:"op", c:"Delhi"},
{n:"Nangloi Railway station", la:28.68208, lo:77.05596, ln:"Green", st:"op", c:"Delhi"},
{n:"Nawada", la:28.62025, lo:77.04514, ln:"Blue", st:"op", c:"Delhi"},
{n:"Nehru Place", la:28.55148, lo:77.25154, ln:"Violet", st:"op", c:"Delhi"},
{n:"Netaji Subhash Place", la:28.69591, lo:77.15226, ln:"Red", st:"op", c:"Delhi"},
{n:"New Ashok Nagar", la:28.58916, lo:77.30204, ln:"Blue", st:"op", c:"Delhi"},
{n:"New Delhi", la:28.64307, lo:77.22144, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Nirman Vihar", la:28.63663, lo:77.28683, ln:"Blue", st:"op", c:"Delhi"},
{n:"Noida City Centre", la:28.57466, lo:77.35608, ln:"Blue", st:"op", c:"Delhi"},
{n:"Noida Golf Course", la:28.56714, lo:77.34598, ln:"Blue", st:"op", c:"Delhi"},
{n:"Noida Sector 15", la:28.58512, lo:77.31139, ln:"Blue", st:"op", c:"Delhi"},
{n:"Noida Sector 16", la:28.57819, lo:77.31757, ln:"Blue", st:"op", c:"Delhi"},
{n:"Noida Sector 18", la:28.57081, lo:77.32612, ln:"Blue", st:"op", c:"Delhi"},
{n:"Okhla", la:28.54292, lo:77.27504, ln:"Violet", st:"op", c:"Delhi"},
{n:"Paschim Vihar East", la:28.6773, lo:77.11228, ln:"Green", st:"op", c:"Delhi"},
{n:"Paschim Vihar West", la:28.67855, lo:77.10227, ln:"Green", st:"op", c:"Delhi"},
{n:"Patel Chowk", la:28.62295, lo:77.21389, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Patel Nagar", la:28.64498, lo:77.16929, ln:"Blue", st:"op", c:"Delhi"},
{n:"Peera Garhi", la:28.67959, lo:77.09261, ln:"Green", st:"op", c:"Delhi"},
{n:"Pitam Pura", la:28.70317, lo:77.13223, ln:"Red", st:"op", c:"Delhi"},
{n:"Pragati Maidan", la:28.62342, lo:77.2425, ln:"Blue", st:"op", c:"Delhi"},
{n:"Pratap Nagar", la:28.66662, lo:77.19882, ln:"Red", st:"op", c:"Delhi"},
{n:"Preet Vihar", la:28.64171, lo:77.29543, ln:"Blue", st:"op", c:"Delhi"},
{n:"Pul Bangash", la:28.66636, lo:77.20727, ln:"Red", st:"op", c:"Delhi"},
{n:"Punjabi Bagh East", la:28.67289, lo:77.14614, ln:"Green", st:"op", c:"Delhi"},
{n:"Qutab Minar", la:28.51302, lo:77.18648, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Race Course", la:28.59726, lo:77.21088, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Rajdhani Park", la:28.68221, lo:77.04381, ln:"Green", st:"op", c:"Delhi"},
{n:"Rajendra Place", la:28.6425, lo:77.17815, ln:"Blue", st:"op", c:"Delhi"},
{n:"Rajiv Chowk", la:28.63282, lo:77.21826, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Rajouri Garden", la:28.64902, lo:77.1227, ln:"Blue", st:"op", c:"Delhi"},
{n:"Ramakrishna Ashram Marg", la:28.63923, lo:77.2084, ln:"Blue", st:"op", c:"Delhi"},
{n:"Ramesh Nagar", la:28.65274, lo:77.13164, ln:"Blue", st:"op", c:"Delhi"},
{n:"Rithala", la:28.72072, lo:77.10713, ln:"Red", st:"op", c:"Delhi"},
{n:"Rohini East", la:28.7076, lo:77.12591, ln:"Red", st:"op", c:"Delhi"},
{n:"Rohini West", la:28.71483, lo:77.11467, ln:"Red", st:"op", c:"Delhi"},
{n:"Saket", la:28.5206, lo:77.20138, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Sarita Vihar", la:28.52878, lo:77.28826, ln:"Violet", st:"op", c:"Delhi"},
{n:"Satguru Ramsingh Marg", la:28.66199, lo:77.15748, ln:"Green", st:"op", c:"Delhi"},
{n:"Seelampur", la:28.66989, lo:77.26678, ln:"Red", st:"op", c:"Delhi"},
{n:"Shadipur", la:28.6516, lo:77.15824, ln:"Blue", st:"op", c:"Delhi"},
{n:"Shahdara", la:28.67345, lo:77.28962, ln:"Red", st:"op", c:"Delhi"},
{n:"Shastri Nagar", la:28.66999, lo:77.18169, ln:"Red", st:"op", c:"Delhi"},
{n:"Shastri Park", la:28.668, lo:77.24994, ln:"Red", st:"op", c:"Delhi"},
{n:"Shivaji Park", la:28.6749, lo:77.13056, ln:"Green", st:"op", c:"Delhi"},
{n:"Shivaji Stadium", la:28.62901, lo:77.2119, ln:"Orange(Airport)", st:"op", c:"Delhi"},
{n:"Sikandarpur", la:28.48182, lo:77.09235, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Subhash Nagar", la:28.64039, lo:77.10495, ln:"Blue", st:"op", c:"Delhi"},
{n:"Sultanpur", la:28.49927, lo:77.16153, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Surajmal Stadium", la:28.6818, lo:77.07385, ln:"Green", st:"op", c:"Delhi"},
{n:"Tagore Garden", la:28.64379, lo:77.11284, ln:"Blue", st:"op", c:"Delhi"},
{n:"Tilak Nagar", la:28.63657, lo:77.09648, ln:"Blue", st:"op", c:"Delhi"},
{n:"Tis Hazari", la:28.66711, lo:77.21653, ln:"Red", st:"op", c:"Delhi"},
{n:"Tughlakabad", la:28.50254, lo:77.2993, ln:"Violet", st:"op", c:"Delhi"},
{n:"Udyog Bhawan", la:28.61166, lo:77.21198, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Udyog Nagar", la:28.6809, lo:77.08077, ln:"Green", st:"op", c:"Delhi"},
{n:"Uttam Nagar East", la:28.62481, lo:77.0653, ln:"Blue", st:"op", c:"Delhi"},
{n:"Uttam Nagar West", la:28.62177, lo:77.05585, ln:"Blue", st:"op", c:"Delhi"},
{n:"Vaishali", la:28.64997, lo:77.33974, ln:"Blue", st:"op", c:"Delhi"},
{n:"Vidhan Sabha", la:28.68802, lo:77.2214, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Vishwa Vidyalaya", la:28.6948, lo:77.21483, ln:"Yellow", st:"op", c:"Delhi"},
{n:"Welcome", la:28.6718, lo:77.27756, ln:"Red", st:"op", c:"Delhi"},
{n:"Yamuna Bank", la:28.62331, lo:77.26792, ln:"Blue", st:"op", c:"Delhi"},
// All other cities
// ── HYDERABAD — HMRL (69 stations across 3 lines, all operational) ───────────
// Source: Wikipedia "Hyderabad Metro Rail", HMRL official website
// Red Line (Miyapur–LB Nagar, 29 stations)
{n:"Miyapur",                   la:17.4963, lo:78.3485, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"JNTU College",              la:17.4934, lo:78.3595, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"KPHB Colony",               la:17.4896, lo:78.3714, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Kukatpally",                la:17.4850, lo:78.3836, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Balanagar",                 la:17.4785, lo:78.4001, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Moosapet",                  la:17.4693, lo:78.4068, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Bharat Nagar",              la:17.4602, lo:78.4132, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Erragadda",                 la:17.4526, lo:78.4208, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"ESI Hospital",              la:17.4464, lo:78.4300, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"SR Nagar",                  la:17.4558, lo:78.4287, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Ameerpet",                  la:17.4376, lo:78.4490, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Punjagutta",                la:17.4268, lo:78.4516, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Irrum Manzil",              la:17.4204, lo:78.4573, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Khairatabad",               la:17.4179, lo:78.4493, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Lakdi Ka Pool",             la:17.4021, lo:78.4666, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Assembly",                  la:17.4072, lo:78.4756, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Nampally",                  la:17.3949, lo:78.4688, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Gandhi Bhavan",             la:17.3874, lo:78.4756, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Osmania Medical College",   la:17.3818, lo:78.4742, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"MG Bus Station",            la:17.3764, lo:78.4803, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Malakpet",                  la:17.3697, lo:78.4858, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"New Market",                la:17.3617, lo:78.4879, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Musarambagh",               la:17.3548, lo:78.4901, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Dilsukhnagar",              la:17.3673, lo:78.5266, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Chaitanyapuri",             la:17.3673, lo:78.5386, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"Victoria Memorial",         la:17.3673, lo:78.5456, ln:"Red",   st:"op", c:"Hyderabad"},
{n:"LB Nagar",                  la:17.3468, lo:78.5499, ln:"Red",   st:"op", c:"Hyderabad"},
// Blue Line (Nagole–Raidurg, 27 stations)
{n:"Nagole",                    la:17.3699, lo:78.5528, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Uppal",                     la:17.3967, lo:78.5596, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Stadium",                   la:17.3967, lo:78.5481, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"NGRI",                      la:17.4031, lo:78.5323, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Habsiguda",                 la:17.4073, lo:78.5214, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Tarnaka",                   la:17.4101, lo:78.5109, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Mettuguda",                 la:17.4173, lo:78.5068, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Secunderabad East",         la:17.4402, lo:78.5028, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Parade Ground",             la:17.4366, lo:78.4946, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Secunderabad West",         la:17.4343, lo:78.4876, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Begumpet",                  la:17.4456, lo:78.4694, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Prakash Nagar",             la:17.4426, lo:78.4616, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Rasoolpura",                la:17.4384, lo:78.4572, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Paradise",                  la:17.4442, lo:78.4540, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Ameerpet",                  la:17.4376, lo:78.4490, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Yusufguda",                 la:17.4385, lo:78.4287, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Madhura Nagar",             la:17.4380, lo:78.4167, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Vittal Rao Nagar",          la:17.4380, lo:78.4050, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Hitech City",               la:17.4478, lo:78.3768, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Durgam Cheruvu",            la:17.4361, lo:78.3821, ln:"Blue",  st:"op", c:"Hyderabad"},
{n:"Raidurg",                   la:17.4228, lo:78.3800, ln:"Blue",  st:"op", c:"Hyderabad"},
// Green Line (JBS–MGBS, 12 stations)
{n:"JBS Parade Ground",         la:17.4402, lo:78.4980, ln:"Green", st:"op", c:"Hyderabad"},
{n:"Gandhi Hospital",           la:17.4287, lo:78.4916, ln:"Green", st:"op", c:"Hyderabad"},
{n:"Musheerabad",               la:17.4205, lo:78.4880, ln:"Green", st:"op", c:"Hyderabad"},
{n:"RTC X Roads",               la:17.4073, lo:78.4871, ln:"Green", st:"op", c:"Hyderabad"},
{n:"Chikkadpally",              la:17.4003, lo:78.4880, ln:"Green", st:"op", c:"Hyderabad"},
{n:"Vidyanagar",                la:17.3937, lo:78.4880, ln:"Green", st:"op", c:"Hyderabad"},
{n:"Narayanguda",               la:17.3924, lo:78.4948, ln:"Green", st:"op", c:"Hyderabad"},
{n:"Sultan Bazaar",             la:17.3850, lo:78.4881, ln:"Green", st:"op", c:"Hyderabad"},
{n:"MGBS",                      la:17.3764, lo:78.4803, ln:"Green", st:"op", c:"Hyderabad"},

// ── CHENNAI — CMRL (54 stations across 2 lines) ─────────────────────────────
// Line 1 (Wimco Nagar–Chennai Airport, 24 stations)
{n:"Wimco Nagar",               la:13.1437, lo:80.2949, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Tiruvottiyur",              la:13.1583, lo:80.3003, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Pattabiram East",           la:13.1303, lo:80.2815, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Pattabiram Military",       la:13.1222, lo:80.2762, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Porur",                     la:13.0357, lo:80.1573, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Koyambedu",                 la:13.0694, lo:80.1956, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Arumbakkam",                la:13.0735, lo:80.2067, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Vadapalani",                la:13.0524, lo:80.2114, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Ashok Nagar",               la:13.0323, lo:80.2198, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Ekkattuthangal",            la:13.0244, lo:80.2236, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Guindy",                    la:13.0067, lo:80.2206, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Alandur",                   la:12.9984, lo:80.2064, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Nanganallur Road",          la:12.9877, lo:80.1958, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Meenambakkam",              la:12.9835, lo:80.1660, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Chennai Airport",           la:12.9941, lo:80.1708, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Kilpauk Medical College",   la:13.0892, lo:80.2399, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Chennai Central",           la:13.0828, lo:80.2750, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Government Estate",         la:13.0665, lo:80.2780, ln:"Line 1",st:"op", c:"Chennai"},
{n:"High Court",                la:13.0778, lo:80.2764, ln:"Line 1",st:"op", c:"Chennai"},
{n:"Anna Salai - Thousand Lights",la:13.0567,lo:80.2596,ln:"Line 1",st:"op", c:"Chennai"},
// Line 2 (Chennai Central–St Thomas Mount, 21 stations)
{n:"Nehru Park",                la:13.0546, lo:80.2596, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Egmore",                    la:13.0777, lo:80.2688, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Thirumangalam",             la:13.0936, lo:80.2137, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Anna Nagar Tower",          la:13.0851, lo:80.2098, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Anna Nagar East",           la:13.0844, lo:80.2082, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Shenoy Nagar",              la:13.0783, lo:80.2218, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Pachaiyappas College",      la:13.0821, lo:80.2399, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Purasaiwakkam",             la:13.0899, lo:80.2459, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Mannadi",                   la:13.0894, lo:80.2700, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Velachery",                 la:12.9804, lo:80.2209, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Taramani",                  la:12.9804, lo:80.2368, ln:"Line 2",st:"op", c:"Chennai"},
{n:"Sholinganallur",            la:12.9004, lo:80.2270, ln:"Line 2",st:"op", c:"Chennai"},
{n:"St Thomas Mount",           la:13.0043, lo:80.2025, ln:"Line 2",st:"op", c:"Chennai"},

// ── MUMBAI — Operational Lines 1, 2A, 7 ─────────────────────────────────────
// Line 1 (Versova–Ghatkopar, 12 stations, oldest)
{n:"Versova",                   la:19.1313, lo:72.8164, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"DN Nagar",                  la:19.1189, lo:72.8381, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Azad Nagar",                la:19.1111, lo:72.8483, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Airport Road",              la:19.0993, lo:72.8570, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Marol Naka",                la:19.0975, lo:72.8641, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Saki Naka",                 la:19.0893, lo:72.8866, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Asalpha",                   la:19.0857, lo:72.8957, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Jagruti Nagar",             la:19.0855, lo:72.9000, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Ghatkopar",                 la:19.0864, lo:72.9074, ln:"Line 1",st:"op", c:"Mumbai"},
{n:"Andheri",                   la:19.1197, lo:72.8487, ln:"Line 1",st:"op", c:"Mumbai"},
// Line 2A (Dahisar West–DN Nagar, 17 stations)
{n:"Dahisar West",              la:19.2518, lo:72.8527, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Don Bosco",                 la:19.2430, lo:72.8527, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Borivali West",             la:19.2310, lo:72.8529, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Pahadi Goregaon",           la:19.1745, lo:72.8553, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Goregaon West",             la:19.1602, lo:72.8430, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Malad West",                la:19.1864, lo:72.8484, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Aarey Colony",              la:19.1640, lo:72.8636, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Charkop",                   la:19.1925, lo:72.8380, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Kandivali West",            la:19.2053, lo:72.8428, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Eksar",                     la:19.2179, lo:72.8455, ln:"Line 2A",st:"op", c:"Mumbai"},
{n:"Mandapeshwar",              la:19.2275, lo:72.8488, ln:"Line 2A",st:"op", c:"Mumbai"},
// Line 7 (Andheri East–Dahisar East, 13 stations)
{n:"Andheri East",              la:19.1197, lo:72.8499, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Western Express Highway",   la:19.1258, lo:72.8570, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Gundavali",                 la:19.1329, lo:72.8631, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Mogra",                     la:19.1411, lo:72.8649, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Jogeshwari East",           la:19.1420, lo:72.8652, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Jai Prakash Road",          la:19.1517, lo:72.8665, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Goregaon East",             la:19.1567, lo:72.8701, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Ram Mandir",                la:19.1651, lo:72.8707, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Kandivali East",            la:19.2057, lo:72.8635, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Poisar",                    la:19.2174, lo:72.8647, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Akurli",                    la:19.2245, lo:72.8650, ln:"Line 7",st:"op", c:"Mumbai"},
{n:"Dahisar East",              la:19.2420, lo:72.8670, ln:"Line 7",st:"op", c:"Mumbai"},
// Line 2B partial (under construction, key stations near BKC/Airport)
{n:"BKC",                       la:19.0645, lo:72.8693, ln:"Line 2B",st:"uc", c:"Mumbai"},
{n:"CST Mumbai Airport T1",     la:19.0896, lo:72.8656, ln:"Line 2B",st:"uc", c:"Mumbai"},
{n:"Sahar Road",                la:19.0986, lo:72.8712, ln:"Line 2B",st:"uc", c:"Mumbai"},
{n:"CST Mumbai Airport T2",     la:19.0992, lo:72.8682, ln:"Line 2B",st:"uc", c:"Mumbai"},

// ── KOLKATA — Metro (Lines 1–6, partial operational) ─────────────────────────
// Line 1 (Blue, Dakshineswar–New Garia, fully operational)
{n:"Dakshineswar",              la:22.6447, lo:88.3584, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Baranagar",                 la:22.6375, lo:88.3736, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Noapara",                   la:22.6300, lo:88.3736, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Dum Dum",                   la:22.6230, lo:88.4023, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Belgachhia",                la:22.6097, lo:88.3788, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Shyambazar",                la:22.5973, lo:88.3726, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Shobhabazar",               la:22.5930, lo:88.3644, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Girish Park",               la:22.5893, lo:88.3617, ln:"Blue", st:"op", c:"Kolkata"},
{n:"MG Road",                   la:22.5748, lo:88.3534, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Central",                   la:22.5852, lo:88.3534, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Chandni Chowk",             la:22.5730, lo:88.3541, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Esplanade",                 la:22.5700, lo:88.3525, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Park Street",               la:22.5530, lo:88.3519, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Maidan",                    la:22.5493, lo:88.3427, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Rabindra Sadan",            la:22.5432, lo:88.3436, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Netaji Bhavan",             la:22.5385, lo:88.3432, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Jatin Das Park",            la:22.5321, lo:88.3432, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Kalighat",                  la:22.5256, lo:88.3432, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Tollygunge",                la:22.5099, lo:88.3502, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Mahanayak Uttam Kumar",     la:22.5006, lo:88.3527, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Netaji",                    la:22.4882, lo:88.3644, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Masterda Surya Sen",        la:22.4785, lo:88.3752, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Shahid Khudiram",           la:22.4703, lo:88.3865, ln:"Blue", st:"op", c:"Kolkata"},
{n:"Kavi Subhash",              la:22.4631, lo:88.3892, ln:"Blue", st:"op", c:"Kolkata"},
// Line 2 (Green, Howrah–Salt Lake, partially open)
{n:"Howrah Maidan",             la:22.5847, lo:88.3350, ln:"Green",st:"op", c:"Kolkata"},
{n:"Howrah",                    la:22.5852, lo:88.3421, ln:"Green",st:"op", c:"Kolkata"},
{n:"Mahakaran",                 la:22.5680, lo:88.3442, ln:"Green",st:"op", c:"Kolkata"},
{n:"Sealdah",                   la:22.5666, lo:88.3773, ln:"Green",st:"op", c:"Kolkata"},
{n:"Phoolbagan",                la:22.5587, lo:88.3920, ln:"Green",st:"op", c:"Kolkata"},
{n:"Salt Lake Sector V",        la:22.5750, lo:88.4305, ln:"Green",st:"op", c:"Kolkata"},
{n:"Salt Lake Stadium",         la:22.5632, lo:88.4108, ln:"Green",st:"op", c:"Kolkata"},

// ── PUNE — Lines 1 & 2 (operational since 2023) ──────────────────────────────
{n:"PCMC Bhavan",               la:18.6315, lo:73.8058, ln:"Line 1",st:"op", c:"Pune"},
{n:"Bhosari",                   la:18.6244, lo:73.8093, ln:"Line 1",st:"op", c:"Pune"},
{n:"Kasarwadi",                 la:18.5994, lo:73.8153, ln:"Line 1",st:"op", c:"Pune"},
{n:"Phugewadi",                 la:18.5844, lo:73.8193, ln:"Line 1",st:"op", c:"Pune"},
{n:"Dapodi",                    la:18.5742, lo:73.8264, ln:"Line 1",st:"op", c:"Pune"},
{n:"Bopodi",                    la:18.5659, lo:73.8343, ln:"Line 1",st:"op", c:"Pune"},
{n:"Khadki",                    la:18.5590, lo:73.8419, ln:"Line 1",st:"op", c:"Pune"},
{n:"Range Hills",               la:18.5491, lo:73.8504, ln:"Line 1",st:"op", c:"Pune"},
{n:"Shivajinagar",              la:18.5292, lo:73.8396, ln:"Line 1",st:"op", c:"Pune"},
{n:"Civil Court",               la:18.5140, lo:73.8576, ln:"Line 1",st:"op", c:"Pune"},
{n:"Budhwar Peth",              la:18.5093, lo:73.8600, ln:"Line 1",st:"op", c:"Pune"},
{n:"Mandai",                    la:18.5027, lo:73.8656, ln:"Line 1",st:"op", c:"Pune"},
{n:"Pune Railway Station",      la:18.5290, lo:73.8739, ln:"Line 1",st:"op", c:"Pune"},
{n:"Ruby Hall Clinic",          la:18.5341, lo:73.8821, ln:"Line 1",st:"op", c:"Pune"},
{n:"Bund Garden",               la:18.5365, lo:73.8914, ln:"Line 1",st:"op", c:"Pune"},
{n:"Yerawada",                  la:18.5405, lo:73.8980, ln:"Line 1",st:"op", c:"Pune"},
{n:"Kalyani Nagar",             la:18.5470, lo:73.9094, ln:"Line 1",st:"op", c:"Pune"},
{n:"Ramwadi",                   la:18.5542, lo:73.9196, ln:"Line 1",st:"op", c:"Pune"},
{n:"Vanaz",                     la:18.5064, lo:73.8171, ln:"Line 2",st:"op", c:"Pune"},
{n:"Anand Nagar",               la:18.5185, lo:73.8230, ln:"Line 2",st:"op", c:"Pune"},
{n:"Ideal Colony",              la:18.5271, lo:73.8292, ln:"Line 2",st:"op", c:"Pune"},
{n:"Nal Stop",                  la:18.5233, lo:73.8430, ln:"Line 2",st:"op", c:"Pune"},
{n:"Garware College",           la:18.5212, lo:73.8513, ln:"Line 2",st:"op", c:"Pune"},
{n:"Deccan Gymkhana",           la:18.5186, lo:73.8567, ln:"Line 2",st:"op", c:"Pune"},
{n:"PMC",                       la:18.5122, lo:73.8577, ln:"Line 2",st:"op", c:"Pune"},
{n:"Mangalwar Peth",            la:18.5027, lo:73.8656, ln:"Line 2",st:"op", c:"Pune"},
{n:"Swami Vivekanand Nagar",    la:18.5149, lo:73.8714, ln:"Line 2",st:"op", c:"Pune"},
{n:"Market Yard",               la:18.5049, lo:73.8619, ln:"Line 2",st:"op", c:"Pune"},

// ── AHMEDABAD — GMRC (2 lines, 47 stations) ─────────────────────────────────
{n:"Thaltej Gam",               la:23.0677, lo:72.5062, ln:"Line 2",st:"op", c:"Ahmedabad"},
{n:"Thaltej",                   la:23.0541, lo:72.5165, ln:"Line 2",st:"op", c:"Ahmedabad"},
{n:"Gujarat University",        la:23.0374, lo:72.5445, ln:"Line 2",st:"op", c:"Ahmedabad"},
{n:"Commerce Six Roads",        la:23.0345, lo:72.5523, ln:"Line 2",st:"op", c:"Ahmedabad"},
{n:"S P Stadium",               la:23.0271, lo:72.5619, ln:"Line 2",st:"op", c:"Ahmedabad"},
{n:"Old High Court",            la:23.0334, lo:72.5793, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Shahpur",                   la:23.0480, lo:72.5717, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Gheekantha",                la:23.0393, lo:72.5726, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Kalupur Railway Station",   la:23.0339, lo:72.5987, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Kankaria East",             la:23.0080, lo:72.6048, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Apparel Park",              la:23.0190, lo:72.6553, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Amraiwadi",                 la:23.0287, lo:72.6288, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Vastral Gam",               la:23.0100, lo:72.6702, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Motera Stadium",            la:23.0996, lo:72.5988, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Ranip",                     la:23.0782, lo:72.5824, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Chandkheda",                la:23.1003, lo:72.6032, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Sabarmati",                 la:23.0707, lo:72.5884, ln:"Line 1",st:"op", c:"Ahmedabad"},
{n:"Gandhinagar Capital",       la:23.2156, lo:72.6369, ln:"Line 1",st:"op", c:"Ahmedabad"},

// ── NOIDA / GREATER NOIDA — NMRC (21 stations) ──────────────────────────────
{n:"Noida Sector 51",           la:28.6224, lo:77.3700, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 50",           la:28.6148, lo:77.3700, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 76",           la:28.6138, lo:77.3800, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 101",          la:28.5792, lo:77.3823, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 81",           la:28.5905, lo:77.3815, ln:"Aqua",  st:"op", c:"Noida"},
{n:"NSEZ",                      la:28.5806, lo:77.3906, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 83",           la:28.5786, lo:77.3996, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 137",          la:28.5406, lo:77.3869, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 142",          la:28.5374, lo:77.4005, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 143",          la:28.5327, lo:77.4132, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Noida Sector 144",          la:28.5279, lo:77.4268, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Knowledge Park II",         la:28.4781, lo:77.4783, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Pari Chowk",                la:28.4721, lo:77.5062, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Alpha 1",                   la:28.4756, lo:77.5132, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Delta 1",                   la:28.4796, lo:77.5183, ln:"Aqua",  st:"op", c:"Noida"},
{n:"GNIDA Office",              la:28.4774, lo:77.5024, ln:"Aqua",  st:"op", c:"Noida"},
{n:"Depot Station",             la:28.4825, lo:77.5240, ln:"Aqua",  st:"op", c:"Noida"},

// ── GURUGRAM / RAPID METRO (6 stations) ─────────────────────────────────────
{n:"Sikanderpur",               la:28.4794, lo:77.0906, ln:"Rapid", st:"op", c:"Gurugram"},
{n:"Phase 1",                   la:28.4896, lo:77.0919, ln:"Rapid", st:"op", c:"Gurugram"},
{n:"Vodafone Belvedere Towers", la:28.4988, lo:77.0930, ln:"Rapid", st:"op", c:"Gurugram"},
{n:"Micromax Moulsari Avenue",  la:28.5078, lo:77.0942, ln:"Rapid", st:"op", c:"Gurugram"},
{n:"Cyber City",                la:28.4950, lo:77.0891, ln:"Rapid", st:"op", c:"Gurugram"},
{n:"Sector 42-43",              la:28.5037, lo:77.0933, ln:"Rapid", st:"op", c:"Gurugram"},

// ── KOCHI — Line 1 (25 stations, operational) ───────────────────────────────
{n:"Aluva",                     la:10.1078, lo:76.3515, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Pulinchodu",                la:10.0890, lo:76.3468, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Companypady",               la:10.0714, lo:76.3390, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Ambattukavu",               la:10.0515, lo:76.3287, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Muttom",                    la:10.0332, lo:76.3162, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Kalamassery",               la:10.0539, lo:76.3202, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Edapally",                  la:10.0214, lo:76.3042, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Changampuzha Park",         la:9.9975,  lo:76.2978, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Palarivattom",              la:10.0122, lo:76.3084, ln:"Line 1",st:"op", c:"Kochi"},
{n:"JLN Stadium",               la:9.9886,  lo:76.2998, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Kaloor",                    la:10.0019, lo:76.2905, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Lissie",                    la:9.9870,  lo:76.2853, ln:"Line 1",st:"op", c:"Kochi"},
{n:"MG Road",                   la:9.9312,  lo:76.2673, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Maharajas",                 la:10.0019, lo:76.2905, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Kadavanthara",              la:9.9693,  lo:76.2895, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Elamkulam",                 la:9.9621,  lo:76.2927, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Vyttila",                   la:9.9530,  lo:76.3082, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Thykoodam",                 la:9.9448,  lo:76.3240, ln:"Line 1",st:"op", c:"Kochi"},
{n:"Tripunithura",              la:9.9448,  lo:76.3458, ln:"Line 1",st:"op", c:"Kochi"},

// ── NAGPUR — Line 1 & 2 ──────────────────────────────────────────────────────
{n:"Automotive Square",         la:21.1768, lo:79.0613, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"Kasturchand Park",          la:21.1547, lo:79.0784, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"Sitabuldi Interchange",     la:21.1490, lo:79.0731, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"Congress Nagar",            la:21.1358, lo:79.0889, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"Rahate Colony",             la:21.1090, lo:79.0840, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"Bansi Nagar",               la:21.0950, lo:79.0821, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"Ujwal Nagar",               la:21.0823, lo:79.0764, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"Prajapati Nagar",           la:21.0668, lo:79.0714, ln:"Line 1",st:"op", c:"Nagpur"},
{n:"VNIT",                      la:21.1298, lo:79.0563, ln:"Line 2",st:"op", c:"Nagpur"},
{n:"Ambedkar Square",           la:21.1450, lo:79.0633, ln:"Line 2",st:"op", c:"Nagpur"},
{n:"GPO",                       la:21.1426, lo:79.0833, ln:"Line 2",st:"op", c:"Nagpur"},
{n:"Itwari Railway Station",    la:21.1456, lo:79.1069, ln:"Line 2",st:"op", c:"Nagpur"},
{n:"Gaddigodam",                la:21.1377, lo:79.1162, ln:"Line 2",st:"op", c:"Nagpur"},
];

// ── Look up nearest metro stations from a static dataset ────────────────────
// No API call, no network dependency — pure JS computation.
function getNearestMetroStations(searchLat, searchLng, maxKm=5, maxResults=5) {
  return INDIA_METRO_STATIONS
    .map(s => ({...s, km: Math.round(haversineKm(searchLat, searchLng, s.la, s.lo)*10)/10}))
    .filter(s => s.km <= maxKm)
    .sort((a,b) => a.km - b.km)
    .filter((s, i, arr) => {
      // Deduplicate: keep only one entry per station name (some interchange
      // stations appear on multiple lines — show closest-listed one only)
      return arr.findIndex(x => x.n === s.n) === i;
    })
    .slice(0, maxResults);
}

// ── Metro Connectivity Card — uses the static dataset above ─────────────────
// No API calls, no network requests, works instantly everywhere including
// the Claude.ai artifact sandbox. Data is curated from BMRCL/DMRC/HMRL/CMRL
// etc. official sources, cited mid-2026.
function MetroConnectivityCard({lat, lng, locationName}) {
  if(!lat || !lng) return null;
  // Just show the single nearest station and distance — that's all the user needs
  const nearest = getNearestMetroStations(lat, lng, 10, 1);
  if(!nearest.length) return null; // no station within 10km, don't show card at all

  const s = nearest[0];
  return(
    <div style={{background:"#F0FDF4",borderRadius:10,border:"1px solid #86EFAC",padding:"11px 13px",
      display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontSize:20,flexShrink:0}}>🚇</span>
      <div style={{flex:1,fontFamily:"Inter,sans-serif"}}>
        <div style={{fontWeight:700,fontSize:13,color:"#15803D"}}>
          {s.n} — {s.km} km away
        </div>
        <div style={{fontSize:11,color:"#166534",marginTop:1}}>
          {s.ln} Line · {s.c} Metro · <span style={{fontWeight:600}}>● Operational</span>
        </div>
      </div>
    </div>
  );
}

function KarnatakaInfraCard({locationName}){
  const ctx = getKarnatakaInfraContext(locationName);

  // Only show lines actually under construction or pre-construction near this locality
  // Operational lines already served by MetroConnectivityCard above — no duplication
  const upcomingLines = ctx.relevantLines.filter(l => l.status !== "operational");

  // Don't render at all if nothing relevant is coming up
  if(upcomingLines.length === 0) return null;

  return(
    <div style={{background:"#FFF7ED",borderRadius:10,border:"1px solid #FED7AA",padding:"11px 13px"}}>
      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:"#C2410C",marginBottom:8,
        display:"flex",alignItems:"center",gap:6}}>
        🚧 Upcoming Metro near {locationName}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {upcomingLines.map(line=>(
          <div key={line.name} style={{display:"flex",justifyContent:"space-between",
            alignItems:"flex-start",gap:8}}>
            <div style={{flex:1}}>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,
                color:"#9A3412"}}>{line.name}</div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#C2410C",
                marginTop:1,lineHeight:1.4}}>{line.note}</div>
            </div>
            <span style={{flexShrink:0,fontFamily:"Inter,sans-serif",fontSize:9,fontWeight:600,
              padding:"2px 7px",borderRadius:10,background:"#FFEDD5",color:"#9A3412",
              whiteSpace:"nowrap"}}>{line.status}</span>
          </div>
        ))}
      </div>
      <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:"#C2410C",marginTop:8,
        fontStyle:"italic",opacity:0.7}}>
        Source: {ctx.source} · {ctx.asOf} — timelines often slip
      </div>
    </div>
  );
}


function ReportCard({data,pins}){
  const [modal,setModal]=useState(false);
  const [showScoreInfo,setShowScoreInfo]=useState(false);
  if(!data) return null;
  // Recompute the headline score deterministically from sub-scores rather than
  // trusting the AI's own arithmetic — see computeGrowthScore() for the formula.
  const computedScore = computeGrowthScore(data);
  const aiScore = data.growth_score;
  const scoreDiverges = aiScore!=null && Math.abs(computedScore - aiScore) > 8;
  const isKarnataka = (data.state||"").toLowerCase().includes("karnataka");
  const gc=scoreColor(computedScore||0),rc=recoColor(data.recommendation);
  const SCORES=[
    {l:"Infrastructure",k:"infrastructure_score"},{l:"Population",k:"population_score"},
    {l:"Economic",k:"economic_score"},{l:"Connectivity",k:"connectivity_score"},
    {l:"Urban Expansion",k:"urban_expansion_score"},{l:"Momentum",k:"market_momentum_score"},
    {l:"Scarcity",k:"scarcity_score"},{l:"Catalyst",k:"catalyst_score"},{l:"Risk",k:"risk_score"},
  ];
  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {modal&&<ScoreModal onClose={()=>setModal(false)}/>}
      <div style={{background:C.navy,borderRadius:12,padding:"18px 20px",display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{color:"#94A3B8",fontSize:10,letterSpacing:1.4,textTransform:"uppercase",fontFamily:"Inter,sans-serif",marginBottom:3}}>{data.state} · {data.district}</div>
          <div style={{color:"#F8FAFB",fontSize:20,fontFamily:"serif"}}>{data.location_name}</div>
          <div style={{color:"#94A3B8",fontSize:12,marginTop:3,fontFamily:"Inter,sans-serif"}}>{data.current_land_price}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:7}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{background:gc,color:"#fff",borderRadius:8,padding:"5px 13px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:20}}>{computedScore}<span style={{fontSize:11,fontWeight:400}}>/100</span></div>
            <button onClick={()=>setShowScoreInfo(!showScoreInfo)}
              style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",
                borderRadius:"50%",width:20,height:20,fontSize:11,cursor:"pointer",flexShrink:0}}>ⓘ</button>
          </div>
          <div style={{background:rc+"22",border:`1.5px solid ${rc}`,color:rc,borderRadius:20,padding:"3px 12px",fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:11}}>{data.recommendation}</div>
        </div>
      </div>
      {showScoreInfo && (
        <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:"12px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:"#92400E"}}>How this score is calculated</div>
            <ProvenanceBadge type="curated"/>
          </div>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#78350F",lineHeight:1.6}}>
            This {computedScore}/100 is computed with a geometric-mean formula across the 9 sub-scores below (weighted: Infrastructure 25%, Population 20%, Economic 20%, Connectivity 15%, Urban Expansion 10%, Momentum 5%, Scarcity 5%), then adjusted for Risk and Catalyst — rather than using the AI's own headline number directly. A geometric mean means one very low sub-score pulls the total down more than a simple average would, similar to how the UN's Human Development Index works.
            {scoreDiverges && (
              <div style={{marginTop:6,fontWeight:600}}>
                Note: the AI's self-reported score for this location was {aiScore}/100 — a {Math.abs(computedScore-aiScore)}-point difference from the computed score, shown here for transparency.
              </div>
            )}
          </div>
        </div>
      )}
      <div style={{background:"#fff",borderRadius:12,border:`1px solid ${C.border}`,padding:"14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark}}>Intelligence Scores</div>
          <button onClick={()=>setModal(true)} style={{background:C.lightBlue,border:`1px solid #BFDBFE`,color:C.blue,borderRadius:"50%",width:26,height:26,cursor:"pointer",fontWeight:700,fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>ℹ</button>
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:10,justifyContent:"center"}}>
          {SCORES.map(s=><Ring key={s.k} score={data[s.k]||0} label={s.l}/>)}
        </div>
      </div>
      {/* Metro & Rail Connectivity — live lookup from Google Maps Places or
          OpenStreetMap, not from AI memory (which can be stale on new openings
          like Electronic City Yellow Line which opened Aug 2025) */}
      {data.lat&&data.lng&&<MetroConnectivityCard lat={data.lat} lng={data.lng} locationName={data.location_name}/>}
      {isKarnataka && <KarnatakaInfraCard locationName={data.location_name}/>}
      {data.news_signals&&<NewsSignals signals={data.news_signals}/>}
      {data.sentiment_score!=null&&<Sentiment score={data.sentiment_score} label={data.sentiment_summary}/>}
      {/* Future Price Forecast Chart */}
      {(()=>{
        const cagrNum=parseFloat(data.expected_cagr)||10;
        const extractBase=(s)=>{if(!s)return null;const m=String(s).replace(/[₹,]/g,"").match(/\d+/);return m?parseInt(m[0]):null;};
        const baseP=extractBase(data.current_land_price)||1000;
        const pts=[
          {yr:"Now",  p:baseP},
          {yr:"2 Yr", p:Math.round(baseP*Math.pow(1+cagrNum/100,2))},
          {yr:"5 Yr", p:Math.round(baseP*Math.pow(1+cagrNum/100,5))},
          {yr:"10 Yr",p:Math.round(baseP*Math.pow(1+cagrNum/100,10))},
        ];
        const maxP=Math.max(...pts.map(p=>p.p));
        const fmtK=(n)=>n>=100000?(n/100000).toFixed(1)+"L":n>=1000?(n/1000).toFixed(0)+"k":n;
        const colors=["#94A3B8","#60A5FA","#34D399","#1E6B4A"];
        return(
          <div style={{background:"#fff",borderRadius:10,border:"1px solid "+C.border,padding:"14px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark}}>📈 Price Forecast (₹/sqft)</div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.green,fontWeight:600}}>{data.expected_cagr} CAGR</div>
            </div>
            <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginBottom:10}}>
              {data.forecast_2yr&&<span>2yr: {data.forecast_2yr} · </span>}
              {data.forecast_5yr&&<span>5yr: {data.forecast_5yr} · </span>}
              {data.forecast_10yr&&<span>10yr: {data.forecast_10yr}</span>}
            </div>
            <div style={{display:"flex",alignItems:"flex-end",gap:12,height:90,marginBottom:4}}>
              {pts.map((pt,i)=>{
                const barH=Math.max(16,Math.round((pt.p/maxP)*78));
                return(
                  <div key={pt.yr} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:9,fontWeight:700,color:colors[i]}}>{fmtK(pt.p)}</div>
                    <div style={{width:"100%",background:colors[i],borderRadius:"4px 4px 0 0",height:barH+"px",opacity:0.9}}/>
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:12,marginBottom:8}}>
              {pts.map(pt=>(
                <div key={pt.yr} style={{flex:1,textAlign:"center",fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted}}>{pt.yr}</div>
              ))}
            </div>
            <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,background:C.bg,borderRadius:6,padding:"6px 10px"}}>
              ⚠️ AI projection using {cagrNum}% CAGR. Not guaranteed. Verify before investing.
            </div>
          </div>
        );
      })()}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9}}>
        <div style={{background:C.lightBlue,borderRadius:9,padding:"11px 13px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginBottom:2}}>Expected CAGR</div>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:18,color:C.blue}}>{data.expected_cagr}</div>
        </div>
        <div style={{background:"#F0FDF4",borderRadius:9,padding:"11px 13px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginBottom:2}}>Confidence</div>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:18,color:C.green}}>{data.confidence_level}</div>
        </div>
      </div>
      {data.growth_zone&&(
        <div style={{background:gc+"18",border:`1.5px solid ${gc}`,borderRadius:9,padding:"10px 13px",fontFamily:"Inter,sans-serif"}}>
          <span style={{fontWeight:700,color:gc,fontSize:12}}>Zone: </span><span style={{color:C.dark,fontSize:12}}>{data.growth_zone}</span>
        </div>
      )}
      {/* Economic Absorption Card — Dholera/Amaravathi problem:
           plans look great on paper but actual jobs created is minimal */}
      {data.economic_absorption&&(()=>{
        const ea = data.economic_absorption;
        const verdictColor = {
          "Speculative play":"#92400E",
          "Emerging fundamentals":"#1D4ED8",
          "Strong absorption":"#15803D",
          "Oversupplied":"#C84B31",
        }[ea.verdict] || C.muted;
        const gapColor = {High:"#C84B31", Medium:"#F59E0B", Low:"#15803D"}[ea.plan_vs_reality_gap] || C.muted;
        const confidenceColor = {High:"#15803D", Medium:"#F59E0B", Low:"#C84B31", Absent:"#C84B31"}[ea.private_sector_confidence] || C.muted;
        return(
          <div style={{background:"#fff",borderRadius:9,border:`1px solid ${C.border}`,padding:"13px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:C.dark}}>
                🏭 Economic Absorption
              </div>
              <span style={{background:verdictColor,color:"#fff",borderRadius:12,
                padding:"2px 9px",fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:700}}>
                {ea.verdict}
              </span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(96px,1fr))",gap:6,marginBottom:8}}>
              <div style={{background:C.bg,borderRadius:7,padding:"7px 9px"}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:0.4}}>Plan vs Reality</div>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:700,color:gapColor,marginTop:2}}>{ea.plan_vs_reality_gap} gap</div>
              </div>
              <div style={{background:C.bg,borderRadius:7,padding:"7px 9px"}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:0.4}}>Private Sector</div>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:700,color:confidenceColor,marginTop:2}}>{ea.private_sector_confidence}</div>
              </div>
            </div>
            {ea.current_jobs_created&&(
              <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark,marginBottom:5,lineHeight:1.5}}>
                <strong>Jobs:</strong> {ea.current_jobs_created}
              </div>
            )}
            {ea.livability_today&&(
              <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark,marginBottom:5,lineHeight:1.5}}>
                <strong>Livability now:</strong> {ea.livability_today}
              </div>
            )}
            {ea.absorption_risk&&(
              <div style={{background:"#FFF7F5",borderRadius:6,padding:"6px 8px",
                fontFamily:"Inter,sans-serif",fontSize:11,color:"#C84B31",lineHeight:1.5}}>
                ⚠️ {ea.absorption_risk}
              </div>
            )}
          </div>
        );
      })()}
      {data.growth_drivers&&(
        <div style={{background:"#fff",borderRadius:9,border:`1px solid ${C.border}`,padding:"13px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:13,color:C.dark,marginBottom:7}}>📈 Growth Drivers</div>
          <ul style={{margin:0,paddingLeft:16,fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,lineHeight:1.7}}>
            {(Array.isArray(data.growth_drivers)?data.growth_drivers:[data.growth_drivers]).map((d,i)=><li key={i}>{d}</li>)}
          </ul>
        </div>
      )}
      {data.major_risks&&(
        <div style={{background:"#FFF7F5",borderRadius:9,border:`1px solid #FED7CC`,padding:"13px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:13,color:C.red,marginBottom:7}}>⚠️ Major Risks</div>
          <ul style={{margin:0,paddingLeft:16,fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,lineHeight:1.7}}>
            {(Array.isArray(data.major_risks)?data.major_risks:[data.major_risks]).map((r,i)=><li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {data.investment_thesis&&(
        <div style={{background:C.navy,borderRadius:9,padding:"14px 18px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:11,color:"#94A3B8",marginBottom:6,letterSpacing:0.5,textTransform:"uppercase"}}>Investment Thesis</div>
          <div style={{fontFamily:"serif",fontSize:14,color:"#F1F5F9",lineHeight:1.7}}>{data.investment_thesis}</div>
        </div>
      )}
      {/* ── Next Big Thing Detector — 3 sections:
           1. Trajectory: where this place is in its growth arc
           2. Historical Mirror: which now-expensive place looked like this before
           3. Ripple Zones: nearby periphery localities computed from real lat/lng
         ── */}
      {(data.trajectory_profile||data.similar_to||data.ripple_signal)&&(
        <div style={{background:"#FFFBEB",borderRadius:10,border:"1px solid #FDE68A",padding:"14px",display:"flex",flexDirection:"column",gap:12}}>
          <div style={{fontWeight:700,fontSize:13,color:"#92400E",display:"flex",alignItems:"center",gap:6}}>
            🔮 Next Big Thing Detector
            <span style={{background:"#FEF3C7",color:"#92400E",borderRadius:20,padding:"1px 8px",fontSize:9,fontWeight:600}}>AI + curated data</span>
          </div>

          {/* Section 1: Trajectory Stage */}
          {data.trajectory_profile&&(
            <div style={{background:"rgba(255,255,255,0.7)",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:700,color:"#B45309",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>Growth Stage</div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <span style={{background:"#0F1B2D",color:"#F8FAFB",borderRadius:14,padding:"3px 10px",fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:700}}>
                  {data.trajectory_profile.current_stage||"Unknown"}
                </span>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#92400E",fontWeight:600}}>
                  {data.trajectory_profile.investor_window}
                </span>
              </div>
              {data.trajectory_profile.future_trajectory&&(
                <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#78350F",lineHeight:1.5}}>
                  📈 {data.trajectory_profile.future_trajectory}
                </div>
              )}
            </div>
          )}

          {/* Section 2: Historical Mirror */}
          {data.trajectory_profile?.historical_mirror&&(
            <div style={{background:"rgba(255,255,255,0.7)",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:700,color:"#B45309",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>Historical Mirror — where has this been before?</div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:"#78350F",lineHeight:1.5,marginBottom:6}}>
                🪞 {data.trajectory_profile.historical_mirror}
              </div>
              {data.trajectory_profile.price_when_mirror_was_here&&data.trajectory_profile.price_of_mirror_today&&(
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  <div style={{background:"#FEF3C7",borderRadius:6,padding:"4px 8px",fontFamily:"Inter,sans-serif",fontSize:10}}>
                    <span style={{color:"#92400E",fontWeight:600}}>Then: </span>{data.trajectory_profile.price_when_mirror_was_here}
                  </div>
                  <span style={{fontFamily:"serif",fontSize:14,color:"#92400E",alignSelf:"center"}}>→</span>
                  <div style={{background:"#F0FDF4",borderRadius:6,padding:"4px 8px",fontFamily:"Inter,sans-serif",fontSize:10}}>
                    <span style={{color:"#15803D",fontWeight:600}}>Now: </span>{data.trajectory_profile.price_of_mirror_today}
                  </div>
                  {data.trajectory_profile.growth_multiple_achieved&&(
                    <div style={{background:"#0F1B2D",borderRadius:6,padding:"4px 8px",fontFamily:"Inter,sans-serif",fontSize:10,color:"#F8FAFB",fontWeight:700}}>
                      {data.trajectory_profile.growth_multiple_achieved} ↑
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Section 3: Ripple Effect Zones — computed from real lat/lng */}
          {data.lat&&data.lng&&(()=>{
            const ripple = getRippleZones(data.lat, data.lng, data.growth_score||0);
            const aiRipple = data.ripple_signal;
            return ripple.length>0 ? (
              <div style={{background:"rgba(255,255,255,0.7)",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:700,color:"#B45309",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>
                  Ripple Effect Zones — capital overflow to periphery
                </div>
                {aiRipple?.overflow_from&&(
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#78350F",marginBottom:8,lineHeight:1.4}}>
                    💰 {aiRipple.overflow_from}
                    {aiRipple.price_gap&&<span style={{fontWeight:600}}> · {aiRipple.price_gap}</span>}
                  </div>
                )}
                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                  {ripple.map(z=>(
                    <div key={z.name} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:"1px solid rgba(253,230,138,0.5)"}}>
                      <div style={{width:36,height:36,borderRadius:8,background:"#FEF3C7",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"serif",fontSize:12,color:"#92400E",fontWeight:700}}>
                        {z.km}km
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:"#78350F"}}>{z.name}</div>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#92400E"}}>{z.price} · Score {z.score}</div>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:"#B45309",fontStyle:"italic",marginTop:1}}>📍 {z.historicalMirror}</div>
                      </div>
                    </div>
                  ))}
                </div>
                {aiRipple?.absorption_timeline&&(
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#92400E",marginTop:6,fontStyle:"italic"}}>
                    ⏳ {aiRipple.absorption_timeline} · Catalysts: {aiRipple.catalysts_needed}
                  </div>
                )}
                <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:"#B45309",marginTop:5,opacity:0.7}}>
                  Distances computed from coordinates · Prices are curated estimates (mid-2026)
                </div>
              </div>
            ) : null;
          })()}
        </div>
      )}

      {/* Civic Grievances */}
      {data.civic_grievances&&data.civic_grievances.length>0&&(
        <div style={{background:"#FFF7F5",borderRadius:9,border:"1px solid #FED7CC",padding:"13px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:C.red,marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
            🚨 Known Civic Grievances
            <span style={{background:"#FEE2E2",color:C.red,borderRadius:20,padding:"1px 7px",fontSize:9,fontWeight:600}}>AI-detected · verify locally</span>
          </div>
          {data.civic_grievances.map((g,i)=>(
            <div key={i} style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:4}}>
              <span style={{color:C.red,flexShrink:0,fontSize:12}}>•</span>
              <span style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark,lineHeight:1.5}}>{g}</span>
            </div>
          ))}
        </div>
      )}
      {/* Upcoming Civic Projects */}
      {data.upcoming_civic_projects&&data.upcoming_civic_projects.length>0&&(
        <div style={{background:"#FFFBEB",borderRadius:9,border:"1px solid #FDE68A",padding:"13px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:"#92400E",marginBottom:8}}>🏗️ Upcoming Civic Projects</div>
          {data.upcoming_civic_projects.map((p,i)=>(
            <div key={i} style={{background:"rgba(255,255,255,0.7)",borderRadius:7,padding:"8px 10px",marginBottom:6,border:"1px solid #FDE68A"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark}}>{p.project}</div>
                <div style={{background:p.score_impact&&p.score_impact.startsWith("+")?C.green:C.red,color:"#fff",borderRadius:5,padding:"1px 7px",fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>{p.score_impact}</div>
              </div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginTop:2}}>{p.status} · {p.expected_completion}</div>
              {p.price_impact&&<div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.green,marginTop:2,fontWeight:500}}>💰 {p.price_impact}</div>}
            </div>
          ))}
        </div>
      )}
      {/* Price History */}
      {data.price_history&&data.price_history.length>1&&(()=>{
        const hist=[...data.price_history].sort((a,b)=>a.year-b.year);
        const maxP=Math.max(...hist.map(h=>h.price_sqft));
        const minP=Math.min(...hist.map(h=>h.price_sqft));
        const range=maxP-minP||1;
        const totalGain=Math.round(((hist[hist.length-1].price_sqft-hist[0].price_sqft)/hist[0].price_sqft)*100);
        return(
          <div style={{background:"#fff",borderRadius:9,border:"1px solid "+C.border,padding:"13px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
              <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:C.dark}}>📊 Price History (₹/sqft)</div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.green,fontWeight:600}}>+{totalGain}% over {hist.length} yrs</div>
            </div>
            <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginBottom:10}}>AI-estimated from market data · Not guaranteed accurate</div>
            <div style={{display:"flex",alignItems:"flex-end",gap:3,height:70,paddingBottom:2}}>
              {hist.map((h,i)=>{
                const barH=Math.max(10,Math.round(((h.price_sqft-minP)/range)*54)+8);
                const isLast=i===hist.length-1;
                return(
                  <div key={h.year} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:8,color:isLast?C.blue:C.muted,fontWeight:isLast?700:400,whiteSpace:"nowrap"}}>
                      {h.price_sqft>=1000?(h.price_sqft/1000).toFixed(1)+"k":h.price_sqft}
                    </div>
                    <div style={{width:"100%",background:isLast?C.blue:"#BFDBFE",borderRadius:"2px 2px 0 0",height:barH+"px"}}/>
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:4,marginTop:4,justifyContent:"space-between",overflow:"hidden"}}>
              {hist.map((h,i)=>(
                <div key={h.year} style={{flex:1,textAlign:"center",fontFamily:"Inter,sans-serif",fontSize:8,color:C.muted,transform:"rotate(-30deg)",transformOrigin:"center top",marginTop:2}}>{h.year}</div>
              ))}
            </div>
          </div>
        );
      })()}
      {/* Traffic & Crowd Intelligence */}
      {data.traffic_intelligence&&(()=>{
        const t=data.traffic_intelligence;
        const congColor={"Severe":"#C84B31","High":"#F59E0B","Moderate":"#2563EB","Low":"#1E6B4A"}[t.peak_hour_congestion]||"#64748B";
        const densColor={"Very High":"#C84B31","High":"#F59E0B","Moderate":"#2563EB","Low":"#1E6B4A"}[t.crowd_density]||"#64748B";
        const infColor={"Overwhelmed":"#C84B31","Strained":"#F59E0B","Adequate":"#1E6B4A"}[t.infrastructure_vs_population]||"#64748B";
        return(
          <div style={{background:"#fff",borderRadius:10,border:"1px solid "+C.border,padding:"14px"}}>
            <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark,marginBottom:12,display:"flex",alignItems:"center",gap:6}}>
              🚦 Traffic & Crowd Intelligence
            </div>
            {/* Key metrics row */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(96px,1fr))",gap:8,marginBottom:12}}>
              {[
                {label:"Peak Congestion",val:t.peak_hour_congestion,col:congColor},
                {label:"Crowd Density",val:t.crowd_density,col:densColor},
                {label:"Infra vs Population",val:t.infrastructure_vs_population,col:infColor},
              ].map(m=>(
                <div key={m.label} style={{background:m.col+"12",border:"1px solid "+m.col+"40",borderRadius:8,padding:"9px 8px",textAlign:"center"}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,marginBottom:3}}>{m.label}</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:11,color:m.col}}>{m.val}</div>
                </div>
              ))}
            </div>
            {/* Peak hours */}
            {t.peak_hours&&(
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,background:"#FFF7F5",borderRadius:7,padding:"8px 10px"}}>
                <span style={{fontSize:14}}>⏰</span>
                <div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted}}>Peak Traffic Hours</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark}}>{t.peak_hours}</div>
                </div>
              </div>
            )}
            {/* Main bottlenecks */}
            {t.main_bottlenecks&&t.main_bottlenecks.length>0&&(
              <div style={{marginBottom:10}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:600,color:C.dark,marginBottom:5}}>🚧 Known Bottlenecks</div>
                {t.main_bottlenecks.map((b,i)=>(
                  <div key={i} style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:3}}>
                    <span style={{color:C.red,flexShrink:0,fontSize:11}}>•</span>
                    <span style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark}}>{b}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Quick stats grid */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              {t.population_density_sqkm&&(
                <div style={{background:C.bg,borderRadius:7,padding:"8px 10px"}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted}}>Pop. Density</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark}}>{t.population_density_sqkm.toLocaleString()}/km²</div>
                </div>
              )}
              {t.parking_situation&&(
                <div style={{background:C.bg,borderRadius:7,padding:"8px 10px"}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted}}>Parking</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark}}>{t.parking_situation}</div>
                </div>
              )}
              {t.metro_bus_connectivity&&(
                <div style={{background:C.bg,borderRadius:7,padding:"8px 10px"}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted}}>Public Transit</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark}}>{t.metro_bus_connectivity}</div>
                </div>
              )}
              {t.weekend_vs_weekday&&(
                <div style={{background:C.bg,borderRadius:7,padding:"8px 10px",gridColumn:"span 1"}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted}}>Weekend Pattern</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark,lineHeight:1.4}}>{t.weekend_vs_weekday}</div>
                </div>
              )}
            </div>
            {/* Future relief */}
            {t.future_relief&&(
              <div style={{background:"#F0FDF4",borderRadius:7,border:"1px solid #86EFAC",padding:"8px 10px",marginBottom:8}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:600,color:C.green,marginBottom:2}}>🛣️ Relief Coming</div>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark}}>{t.future_relief}</div>
              </div>
            )}
            {/* Investor impact */}
            {t.investor_impact&&(
              <div style={{background:C.lightBlue,borderRadius:7,border:"1px solid #BFDBFE",padding:"8px 10px"}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:600,color:C.blue,marginBottom:2}}>💰 Impact on Property Value</div>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark}}>{t.investor_impact}</div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Water quality */}
      {data.water_quality_note&&(
        <div style={{background:"#EFF6FF",borderRadius:9,border:"1px solid #BFDBFE",padding:"10px 13px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:600,color:C.blue,marginBottom:2}}>💧 Water Quality in This Area</div>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark}}>{data.water_quality_note}</div>
        </div>
      )}

    </div>
  );
}

const LS={fontFamily:"Inter,sans-serif",fontSize:12,color:C.muted,display:"block",marginBottom:3,fontWeight:500};
const IS={width:"100%",border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 11px",fontFamily:"Inter,sans-serif",fontSize:13,color:C.dark,outline:"none",boxSizing:"border-box",background:C.bg};

// ── RERA Search Component ──────────────────────────────────────────────────
// Searches the ETL-built rera_index.json by project name OR company name.
// No registration number needed. Links directly to official state portal.
function RERASearchTab() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [allProjects, setAllProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSource] = useState("loading");

  useEffect(() => {
    // Load RERA index from ETL output
    fetch('/data/rera_index.json')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.projects?.length > 0) {
          setAllProjects(data.projects);
          setDataSource(`${data.projects.length} projects · ${data.states_covered?.length || 0} states`);
        } else {
          setDataSource("unavailable");
        }
        setLoading(false);
      })
      .catch(() => {
        setDataSource("unavailable");
        setLoading(false);
      });
  }, []);

  // Fuzzy search — matches on project name, company name, or city
  // Uses pre-tokenised search_tokens from ETL for fast client-side matching
  const search = (query) => {
    setQ(query);
    if (!query.trim() || query.length < 2) { setResults([]); return; }
    const tokens = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(t => t.length >= 2);
    const scored = allProjects.map(p => {
      const projectTokens = p.search_tokens || [];
      const displayText = (p.search_display || '').toLowerCase();
      // Score: how many query tokens match?
      const matchCount = tokens.filter(t =>
        projectTokens.some(pt => pt.includes(t)) || displayText.includes(t)
      ).length;
      return { ...p, _score: matchCount };
    }).filter(p => p._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 12);
    setResults(scored);
  };

  const statusColor = (s) => ({
    "Completed": "#15803D", "Ongoing": "#1D4ED8",
    "Lapsed": "#C84B31", "Revoked": "#C84B31",
  })[s] || C.muted;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Header */}
      <div style={{background:C.navy,borderRadius:12,padding:"14px 16px"}}>
        <div style={{color:"#F8FAFB",fontFamily:"serif",fontSize:16,marginBottom:4}}>
          🔍 RERA Project Search
        </div>
        <div style={{color:"#94A3B8",fontFamily:"Inter,sans-serif",fontSize:11,lineHeight:1.5}}>
          Search by project name or builder — no registration number needed.
          Links directly to official state RERA portals.
        </div>
      </div>

      {/* Search input */}
      <div style={{display:"flex",gap:8}}>
        <input
          value={q}
          onChange={e => search(e.target.value)}
          placeholder="e.g. Prestige, Godrej, Lodha Palava, Brigade..."
          style={{flex:1,border:"1.5px solid "+C.border,borderRadius:9,padding:"10px 13px",
            fontFamily:"Inter,sans-serif",fontSize:13,color:C.dark,outline:"none"}}
        />
        {q && <button onClick={()=>{setQ("");setResults([]);}}
          style={{background:"none",border:"1px solid "+C.border,borderRadius:9,
            padding:"0 12px",color:C.muted,cursor:"pointer",fontFamily:"Inter,sans-serif",fontSize:12}}>
          Clear
        </button>}
      </div>

      {/* Data source badge */}
      <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,
        display:"flex",alignItems:"center",gap:6}}>
        {loading ? "Loading RERA database..." :
         dataSource === "unavailable"
           ? "⚠️ RERA index not loaded — run etl/02_ingest_infrastructure.py and deploy /data/rera_index.json"
           : `📋 ${dataSource} · Powered by ETL pipeline`}
      </div>

      {/* Results */}
      {q.length >= 2 && !loading && results.length === 0 && (
        <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.muted,
          padding:"14px",background:C.bg,borderRadius:9,textAlign:"center"}}>
          No RERA projects found matching "{q}".
          <br/>
          <span style={{fontSize:11}}>
            Try the builder name (e.g. "Prestige", "Sobha") or part of the project name.
            <br/>
            Or{" "}
            <a href={`https://www.google.com/search?q=RERA+${encodeURIComponent(q)}+site:rera.karnataka.gov.in+OR+site:maharera.mahaonline.gov.in+OR+site:rera.telangana.gov.in`}
              target="_blank" rel="noopener noreferrer"
              style={{color:C.blue}}>search across all state portals →</a>
          </span>
        </div>
      )}

      {results.map((p, i) => (
        <div key={i} style={{background:"#fff",border:"1px solid "+C.border,
          borderRadius:10,padding:"12px 14px",display:"flex",flexDirection:"column",gap:6}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
            <div style={{flex:1}}>
              <div style={{fontFamily:"serif",fontSize:14,color:C.dark,lineHeight:1.3}}>
                {p.project_name}
              </div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,marginTop:2}}>
                {p.company_name}
              </div>
            </div>
            <span style={{flexShrink:0,fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:600,
              padding:"2px 8px",borderRadius:10,
              background: p.status==="Completed"?"#F0FDF4":p.status==="Ongoing"?"#EFF6FF":"#FFF7F5",
              color:statusColor(p.status)}}>
              {p.status}
            </span>
          </div>

          <div style={{display:"flex",gap:12,fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted}}>
            <span>📍 {p.city}{p.district && p.district !== p.city ? `, ${p.district}` : ""}, {p.state}</span>
            <span>🏗️ {p.type}</span>
          </div>

          {p.rera_id && p.rera_id !== "—" && (
            <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,
              background:C.bg,borderRadius:6,padding:"4px 8px"}}>
              RERA ID: <span style={{fontFamily:"monospace",color:C.dark}}>{p.rera_id}</span>
            </div>
          )}

          <div style={{display:"flex",gap:8,marginTop:2}}>
            <a href={p.direct_url} target="_blank" rel="noopener noreferrer"
              style={{fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:600,
                color:"#fff",background:C.blue,borderRadius:7,padding:"5px 12px",
                textDecoration:"none"}}>
              View on {p.state} RERA →
            </a>
            {p.portal_url && (
              <a href={p.portal_url} target="_blank" rel="noopener noreferrer"
                style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.blue,
                  borderRadius:7,padding:"5px 12px",border:"1px solid "+C.blue,
                  textDecoration:"none"}}>
                State portal
              </a>
            )}
          </div>
        </div>
      ))}

      {/* Help text when idle */}
      {!q && !loading && dataSource !== "unavailable" && (
        <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,
          background:C.bg,borderRadius:9,padding:"12px 14px",lineHeight:1.7}}>
          <strong style={{color:C.dark}}>How to search:</strong><br/>
          • Builder name — "Prestige", "Godrej Properties", "Sobha"<br/>
          • Project name — "Palava", "Utopia", "Woodland"<br/>
          • Partial match — "brigade" finds all Brigade projects<br/>
          • City — combined with builder: "Pune Godrej"<br/><br/>
          <strong style={{color:C.dark}}>State portals covered:</strong>{" "}
          Karnataka · Maharashtra · Telangana · Tamil Nadu · Gujarat
        </div>
      )}
    </div>
  );
}

function ScreenerTab(){
  const [f,setF]=useState({city:"Bengaluru",radius:100,minCagr:12,maxPrice:5000,minInfra:70,maxRisk:45});
  const [results,setResults]=useState(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const set=(k,v)=>setF(p=>({...p,[k]:v}));

  const run=async()=>{
    setLoading(true);setResults(null);setError("");
    try{
      const prompt=`You are Bharat Land Growth Intelligence Platform. Find 5 real land investment opportunities within ${f.radius} km of ${f.city}, India.
Filters: Min CAGR ${f.minCagr}%, Max price Rs${f.maxPrice}/sqft, Min infra score ${f.minInfra}/100, Max risk ${f.maxRisk}/100.

SCORING CONSISTENCY — use these verified baselines for known localities (growth_score is computed from sub-scores: infra 25%, population 20%, economic 20%, connectivity 15%, urban_expansion 10%, momentum 5%, scarcity 5%, adjusted for risk and catalyst):
Whitefield/Bengaluru East: growth_score≈80 | Electronic City: growth_score≈72 | Devanahalli: growth_score≈74 | Gachibowli/Hyderabad: growth_score≈83 | Hinjewadi/Pune: growth_score≈76 | Dholera SIR: growth_score≈59 (high catalyst but very low population/scarcity) | Noida/Greater Noida: growth_score≈67

Return ONLY a JSON array (no markdown fences), sorted by growth_score descending.
Each object must have: location, district, state, current_price_sqft, expected_cagr, infrastructure_score (integer), risk_score (integer), growth_score (integer), recommendation, one_line_thesis, lat (number), lng (number).`;
      const cacheKey="screener_"+[f.city,f.radius,f.minCagr,f.maxPrice,f.minInfra,f.maxRisk].join("_").toLowerCase().replace(/[^a-z0-9_]/g,"");
      const res=await fetch(API_ENDPOINT,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:5500,temperature:0,messages:[{role:"user",content:prompt}],cacheKey,cacheType:"screener"}),
      });
      const d=await res.json();
      if(d.error){setError("API: "+d.error.message);setLoading(false);return;}
      const text=d.content?.map(b=>b.text||"").join("")||"";
      const parsed=parseJSON(text);
      if(parsed&&Array.isArray(parsed)) setResults(parsed.sort((a,b)=>(b.growth_score||0)-(a.growth_score||0)));
      else setError("Parse failed. Preview: "+text.slice(0,300));
    }catch(e){setError("Error: "+e.message);}
    setLoading(false);
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fff",borderRadius:12,border:`1px solid ${C.border}`,padding:"18px"}}>
        <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:14,color:C.dark,marginBottom:12}}>🔍 Smart Opportunity Screener</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11}}>
          <div><label style={LS}>Base City</label><input value={f.city} onChange={e=>set("city",e.target.value)} style={IS} placeholder="e.g. Bengaluru"/></div>
          <div><label style={LS}>Radius: <strong>{f.radius} km</strong></label><input type="range" min={20} max={300} value={f.radius} onChange={e=>set("radius",+e.target.value)} style={{width:"100%",marginTop:6}}/></div>
          <div><label style={LS}>Min CAGR: <strong>{f.minCagr}%</strong></label><input type="range" min={5} max={30} value={f.minCagr} onChange={e=>set("minCagr",+e.target.value)} style={{width:"100%",marginTop:6}}/></div>
          <div><label style={LS}>Max Price: <strong>₹{f.maxPrice.toLocaleString()}</strong></label><input type="range" min={500} max={15000} step={500} value={f.maxPrice} onChange={e=>set("maxPrice",+e.target.value)} style={{width:"100%",marginTop:6}}/></div>
          <div><label style={LS}>Min Infra: <strong>{f.minInfra}</strong></label><input type="range" min={30} max={100} value={f.minInfra} onChange={e=>set("minInfra",+e.target.value)} style={{width:"100%",marginTop:6}}/></div>
          <div><label style={LS}>Max Risk: <strong>{f.maxRisk}</strong></label><input type="range" min={10} max={80} value={f.maxRisk} onChange={e=>set("maxRisk",+e.target.value)} style={{width:"100%",marginTop:6}}/></div>
        </div>
        <button onClick={run} disabled={loading} style={{marginTop:13,width:"100%",background:loading?C.muted:C.blue,color:"#fff",border:"none",borderRadius:8,padding:"11px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,cursor:loading?"default":"pointer"}}>
          {loading?"Scanning…":"Find Best Opportunities →"}
        </button>
      </div>
      {error&&<div style={{color:C.red,fontFamily:"Inter,sans-serif",fontSize:11,padding:"9px 13px",background:"#FFF5F5",borderRadius:8,wordBreak:"break-all"}}>{error}</div>}
      {results&&(
        <>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:13,color:C.dark}}>📍 {results.length} Opportunities — hover pins for details</div>
          <MapView pins={results} height={290} focusLat={results[0]?.lat} focusLng={results[0]?.lng} focusZoom={4}/>
          <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
            {[{c:"#1E6B4A",l:"High Growth (80+)"},{c:"#2563EB",l:"Growth (65–79)"},{c:"#F59E0B",l:"Stable (50–64)"}].map(x=>(
              <div key={x.l} style={{display:"flex",alignItems:"center",gap:5,fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:x.c}}/>{x.l}
              </div>
            ))}
          </div>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:13,color:C.dark}}>Ranked by Return Potential</div>
          {results.map((r,i)=>{
            const rc2=recoColor(r.recommendation),gc2=scoreColor(r.growth_score||0);
            return(
              <div key={i} style={{background:"#fff",borderRadius:11,border:`1px solid ${C.border}`,padding:"13px",display:"flex",flexDirection:"column",gap:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:6}}>
                  <div style={{display:"flex",gap:7,alignItems:"flex-start"}}>
                    <div style={{background:gc2,color:"#fff",borderRadius:5,width:27,height:27,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Inter,sans-serif",fontWeight:800,fontSize:11,flexShrink:0}}>#{i+1}</div>
                    <div>
                      <div style={{fontFamily:"serif",fontSize:15,color:C.dark}}>{r.location}</div>
                      <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted}}>{r.district}, {r.state}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:5,alignItems:"center"}}>
                    <div style={{background:gc2,color:"#fff",borderRadius:5,padding:"3px 8px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12}}>{r.growth_score}</div>
                    <div style={{background:rc2+"20",border:`1.5px solid ${rc2}`,color:rc2,borderRadius:20,padding:"2px 9px",fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:10}}>{r.recommendation}</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(80px,1fr))",gap:5}}>
                  {[["Price",r.current_price_sqft],["CAGR",r.expected_cagr],["Infra",`${r.infrastructure_score}/100`],["Risk",`${r.risk_score}/100`]].map(([l,v])=>(
                    <div key={l} style={{background:C.bg,borderRadius:6,padding:"5px 7px"}}>
                      <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted}}>{l}</div>
                      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:11,color:C.dark}}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,borderTop:`1px solid ${C.border}`,paddingTop:6,lineHeight:1.6}}>{r.one_line_thesis}</div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,paddingTop:4,fontStyle:"italic"}}>
                💡 Screener gives quick estimates — use Analyze for verified scores
              </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

const SYS=`You are Bharat Land Growth Intelligence Platform — India's elite AI land investment intelligence system.
Today's date is ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}.

Analyze the given Indian location. Return ONLY a raw JSON object starting with { and ending with }. No markdown, no fences.

PRICING ACCURACY IS CRITICAL: current_land_price MUST follow this EXACT format: "₹[MIN]–[MAX]/sqft" (e.g. "₹12,000–22,000/sqft"). Use the reference anchors below — these are curated from Magicbricks/99acres/JLL India/NoBroker research (mid-2026). You MUST use the exact min–max from the anchor table when the locality matches. Do NOT reformat, do NOT change the range, do NOT add extra text to the price field itself (save commentary for locality_insight instead).

PRICE REFERENCE ANCHORS — use the EXACT range as written:
Whitefield/ITPL belt (Bengaluru): ₹12,000–22,000/sqft | Sarjapur Road (Bengaluru): ₹8,000–16,000/sqft | Koramangala (Bengaluru): ₹25,000–50,000/sqft | Devanahalli/Airport (Bengaluru): ₹4,000–9,000/sqft | Electronic City (Bengaluru): ₹5,000–10,000/sqft | HSR Layout (Bengaluru): ₹20,000–40,000/sqft | JP Nagar (Bengaluru): ₹12,000–22,000/sqft | Yelahanka (Bengaluru): ₹5,000–10,000/sqft | Hebbal (Bengaluru): ₹12,000–22,000/sqft | Kanakapura Road outer (Bengaluru): ₹3,000–7,000/sqft | Kaggalipura/periphery (Bengaluru): ₹2,500–5,500/sqft | Hinjewadi/Wakad (Pune): ₹6,000–14,000/sqft | Navi Mumbai: ₹8,000–18,000/sqft | Thane: ₹9,000–18,000/sqft | OMR Corridor (Chennai): ₹5,000–12,000/sqft | Porur/Poonamallee (Chennai): ₹6,000–13,000/sqft | Tambaram (Chennai): ₹3,500–8,000/sqft | Gachibowli/HITEC City (Hyderabad): ₹15,000–35,000/sqft | Kompally/Medchal (Hyderabad): ₹5,000–10,000/sqft | Shamshabad (Hyderabad): ₹3,500–8,000/sqft | Dholera SIR (Gujarat): ₹1,500–6,000/sqft | Ahmedabad metro: ₹3,000–12,000/sqft | Surat: ₹3,500–9,000/sqft | Gurugram (DLF/Golf Course): ₹15,000–50,000/sqft | Noida: ₹5,000–20,000/sqft | Greater Noida: ₹3,000–8,000/sqft

For localities NOT in this table: use your best knowledge but flag confidence_level as "Low" or "Medium" and avoid round numbers (use a specific range like ₹4,800–9,200/sqft).

SCORING ANCHORS — for these localities, use these sub-scores as your FIXED baseline. Only deviate if you have a specific, named, verifiable recent fact that genuinely changes a score, and explain it in locality_insight:
Whitefield (Bengaluru): infrastructure:78, population:72, economic:88, connectivity:74, urban_expansion:68, market_momentum:82, scarcity:70, risk:35, catalyst:68
Sarjapur Road (Bengaluru): infrastructure:70, population:75, economic:78, connectivity:68, urban_expansion:80, market_momentum:76, scarcity:72, risk:38, catalyst:72
Electronic City (Bengaluru): infrastructure:72, population:68, economic:82, connectivity:65, urban_expansion:62, market_momentum:70, scarcity:65, risk:32, catalyst:60
Devanahalli (Bengaluru): infrastructure:75, population:55, economic:70, connectivity:68, urban_expansion:85, market_momentum:78, scarcity:60, risk:42, catalyst:82
Kanakapura Road (Bengaluru): infrastructure:55, population:58, economic:52, connectivity:54, urban_expansion:72, market_momentum:62, scarcity:68, risk:45, catalyst:65
HSR Layout (Bengaluru): infrastructure:76, population:80, economic:85, connectivity:78, urban_expansion:50, market_momentum:72, scarcity:82, risk:28, catalyst:58
Gachibowli (Hyderabad): infrastructure:80, population:78, economic:88, connectivity:76, urban_expansion:70, market_momentum:82, scarcity:68, risk:30, catalyst:72
Hinjewadi (Pune): infrastructure:72, population:70, economic:80, connectivity:68, urban_expansion:75, market_momentum:74, scarcity:65, risk:35, catalyst:68
Dholera (Gujarat): infrastructure:60, population:30, economic:65, connectivity:55, urban_expansion:90, market_momentum:72, scarcity:40, risk:55, catalyst:90

SCORING CONSISTENCY: For ALL other localities not in the anchor table above — before assigning any sub-score, state the specific observable fact that drives it. Each sub-score must follow directly from a named, verifiable fact. Round numbers (50, 60, 70, 80) suggest estimation — use specific integers to show actual reasoning.

CRITICAL REQUIREMENTS:
1. news_signals: Include ALL known government signals — CM/Minister/PM statements, proposed airports, metro extensions, highway approvals, budget allocations, industrial zones, court orders. MUST include any upcoming civic projects that will INCREASE or DECREASE the score.
2. civic_grievances: Based on your knowledge, list REAL known grievances for this area (waterlogging, traffic, power cuts, encroachment, pollution).
3. price_history: Provide approximate price per sqft for last 5-10 years (use realistic market knowledge).
4. comparable_projects: Each must include a Google Maps search link in format: https://www.google.com/maps/search/PROJECT+NAME+LOCALITY+CITY

Required JSON keys:
location_name, state, district, current_land_price,
growth_score (int — your best independent estimate; note this is cross-checked client-side against a deterministic formula applied to your sub-scores below, so make sure the sub-scores honestly reflect your reasoning rather than working backward from a target headline number),
risk_score (int), infrastructure_score (int), population_score (int),
economic_score (int), connectivity_score (int), urban_expansion_score (int),
market_momentum_score (int), scarcity_score (int), catalyst_score (int),
forecast_2yr, forecast_5yr, forecast_10yr, expected_cagr, confidence_level, growth_zone,
growth_drivers (array 5 strings), major_risks (array 4 strings),
recommendation ("Buy Now"|"Accumulate"|"Watchlist"|"Hold"|"Avoid"),
investment_thesis (string),
trajectory_profile (object: {
  current_stage: "Early Discovery"|"Rising"|"Established"|"Maturing"|"Saturated",
  historical_mirror: "which specific famous locality at which specific year does this place resemble right now, and why — e.g. 'Electronic City in 2010: similar IT absorption rate, similar connectivity gap, similar price band'",
  future_trajectory: "which locality does this place most likely become in 10 years and why",
  price_when_mirror_was_here: "approximate price of the historical mirror locality at that reference year",
  price_of_mirror_today: "approximate price of that same historical mirror locality today",
  growth_multiple_achieved: "how many times the historical mirror grew from then to now — e.g. '4x in 12 years'",
  investor_window: "Early-Stage Opportunity"|"Active Appreciation Window"|"Late-Stage Entry"|"Post-Peak"
}),
similar_to (string — keep for backward compatibility, same as trajectory_profile.historical_mirror summary),
similarity_score (string),
locality_insight (string — REQUIRED: explain what specific facts drove your scoring, and if you deviated from any anchor table value, state exactly why),
lat (number), lng (number), sentiment_score (int), sentiment_summary (string),
news_signals (array 4 objects: {headline, type (BULLISH|BEARISH|CATALYST|NEUTRAL), impact, price_impact, is_upcoming_civic (boolean)}),
comparable_projects (array of 2-3 objects: {name (string), rate_sqft (string e.g. "₹7,500/sqft"), maps_link (string)}),
civic_grievances (array of 3-5 strings — real known issues for this area),
upcoming_civic_projects (array of 2-4 objects: {project, status, expected_completion, score_impact ("+5"|"-3" etc), price_impact}),
price_history (array of objects: {year (int), price_sqft (int)} — last 8-10 years),
economic_absorption (object: {
  plan_vs_reality_gap: "High"|"Medium"|"Low" — how much do the plans (infra, smart city, capital city) outpace actual on-ground economic activity?
  current_jobs_created: "approximate number of actual jobs created so far vs the grand plan — be specific, e.g. '~8,000 jobs vs 500,000 planned for Dholera SIR'",
  private_sector_confidence: "High"|"Medium"|"Low"|"Absent" — are private companies actually investing or just government-funded?
  livability_today: "Is the area currently livable? Are amenities, utilities, shops, schools actually present or still years away?",
  absorption_risk: "What happens to property if the jobs/plan don't materialize? Concrete risk.",
  verdict: "Speculative play"|"Emerging fundamentals"|"Strong absorption"|"Oversupplied"
}),
ripple_signal (object: {
  overflow_from: "which saturating hub(s) is driving capital toward this locality — e.g. 'Whitefield (avg ₹18,000/sqft) pushing buyers toward Hoskote'",
  distance_from_hub: "approximate km from that hub",
  price_gap: "current price gap between hub and this locality — e.g. '3x cheaper than Whitefield'",
  absorption_timeline: "estimated years before this locality reaches hub-like pricing — e.g. '5-8 years'",
  catalysts_needed: "what specific things would accelerate this — e.g. 'metro connectivity, SH-35 widening, IT park announcement'"
}),
water_quality_note (string),
traffic_intelligence (object: {
  peak_hour_congestion: "Severe/High/Moderate/Low",
  peak_hours: "e.g. 8-10am and 6-9pm",
  main_bottlenecks: [array of 2-3 specific road/junction names with issue],
  crowd_density: "Very High/High/Moderate/Low",
  population_density_sqkm: integer estimate,
  infrastructure_vs_population: "Adequate/Strained/Overwhelmed",
  metro_bus_connectivity: "Excellent/Good/Average/Poor",
  parking_situation: "Easy/Moderate/Difficult/Very Difficult",
  weekend_vs_weekday: string (1 sentence),
  future_relief: string (1 sentence),
  investor_impact: string (1 sentence)
})

Scoring: Infrastructure 25%, Population 20%, Economic 20%, Connectivity 15%, Urban 10%, Momentum 5%, Scarcity 5%.
Zones: 90-100 Mega Growth, 80-89 Emerging Hot, 65-79 Growth, 50-64 Stable, <50 High Risk.
`;

// ── Ambiguous locality names — same name exists in multiple parts of a city/state
// When a user searches one of these, we ask which one they mean before running analysis.
// Extend this list as more duplicates are discovered. Format: name → array of contexts.
const AMBIGUOUS_LOCALITIES = {
  // Bengaluru
  "alnahalli":     ["Alnahalli, Mysuru (residential area off Outer Ring Road, Mysuru)", "Alnahalli, Bengaluru (near Tumkur Road, North-West Bengaluru)"],
  "kalkere":       ["Kalkere, Ramamurthy Nagar area (East Bengaluru, near ITPL)", "Kalkere, Bannerghatta Road (South Bengaluru, near JP Nagar)"],
  "hennur":        ["Hennur, off Hennur Road (North Bengaluru, near Kalyan Nagar)", "Hennur Village, near Devanahalli Road (Far North Bengaluru)"],
  "kothanur":      ["Kothanur, Bannerghatta Road (South Bengaluru)", "Kothanur, Hennur (North Bengaluru)"],
  "hegde nagar":   ["Hegde Nagar, near Manyata Tech Park (North Bengaluru)", "Hegde Nagar, near Yelahanka (Far North Bengaluru)"],
  "singasandra":   ["Singasandra, Hosur Road belt (South Bengaluru, near Yellow Line metro)", "Singasandra, off Bannerghatta Road (South-West Bengaluru)"],
  "varthur":       ["Varthur, near Whitefield (East Bengaluru IT corridor)", "Varthur Road, near Sarjapur (South-East Bengaluru)"],
  "bellandur":     ["Bellandur, Outer Ring Road (near Sarjapur, East Bengaluru)", "Bellandur Village, off Sarjapur Road"],
  "bommanahalli":  ["Bommanahalli, Hosur Road / Yellow Line area", "Bommanahalli, near Koramangala (inner city)"],
  "mahadevapura":  ["Mahadevapura, near Whitefield (East Bengaluru)", "Mahadevapura, near KR Puram (East Bengaluru)"],
  // Delhi / NCR
  "sector 62":     ["Sector 62, Noida (near Delhi-Noida border)", "Sector 62, Gurugram (near NH48)"],
  "dlf city":      ["DLF City Phase 1/2/3, Gurugram (near Sikanderpur)", "DLF City Phase 4/5, Gurugram (near Golf Course Road)"],
  "vasant kunj":   ["Vasant Kunj, South Delhi (near Airport Line)", "Vasant Kunj, near Vasant Vihar (South Delhi)"],
  // Mumbai
  "andheri":       ["Andheri West (residential, near Versova Metro)", "Andheri East (commercial/industrial, near Airport)"],
  "malad":         ["Malad West (residential, near Mindspace)", "Malad East (mixed use, near Sanjay Gandhi NP)"],
  "ghatkopar":     ["Ghatkopar West (residential)", "Ghatkopar East (commercial, near Metro Line 1)"],
  // Hyderabad
  "kondapur":      ["Kondapur, near HITEC City (West Hyderabad IT belt)", "Kondapur Village, near Narsingi (Outer Hyderabad)"],
  "kukatpally":    ["Kukatpally, near KPHB Colony (mid Hyderabad)", "Kukatpally Housing Board (far west Hyderabad)"],
  // Chennai
  "perungudi":     ["Perungudi, near OMR (IT corridor, South Chennai)", "Perungudi, near Velachery (inner south Chennai)"],
  "sholinganallur":["Sholinganallur, OMR (IT hub, South Chennai)", "Sholinganallur Marsh area (near Perungudi)"],
  // Pune
  "wakad":         ["Wakad, near Hinjewadi Phase 1 (West Pune IT)", "Wakad, near Pimpri (North-West Pune industrial)"],
  "kharadi":       ["Kharadi, near EON IT Park (East Pune IT)", "Kharadi Village, near Wagholi (outer east Pune)"],
};

// Check if a search query matches a known ambiguous locality name
// Returns array of options if ambiguous, empty array if not
function checkAmbiguity(query) {
  if(!query) return [];
  const q = query.toLowerCase().trim();
  // Check exact match or if the query starts with one of the ambiguous names
  for(const [key, options] of Object.entries(AMBIGUOUS_LOCALITIES)) {
    if(q === key || q.startsWith(key + " ") || q.startsWith(key + ",")) {
      return options;
    }
  }
  return [];
}

function AnalyzeTab({initialQuery="",onClear}){
  const [q,setQ]=useState(initialQuery);
  const [loading,setLoading]=useState(false);
  const [report,setReport]=useState(null);
  const [pins,setPins]=useState([]);
  const [error,setError]=useState("");
  const [disambigOptions,setDisambigOptions]=useState([]); // populated when location name is ambiguous
  const ranOnce=useRef(false);

  useEffect(()=>{
    if(initialQuery&&!ranOnce.current){ranOnce.current=true;setQ(initialQuery);doAnalyze(initialQuery);}
  },[initialQuery]);

  const [streamChars,setStreamChars]=useState(0); // repurposed as an elapsed-time tick counter for staged progress messages below

  useEffect(()=>{
    if(!loading){setStreamChars(0);return;}
    const start=Date.now();
    const iv=setInterval(()=>setStreamChars(Date.now()-start),300);
    return ()=>clearInterval(iv);
  },[loading]);

  const doAnalyze=async(query)=>{
    const loc=(query||q).trim();
    if(!loc) return;
    // Check for ambiguous locality names before running the full analysis
    const ambig = checkAmbiguity(loc);
    if(ambig.length > 0 && disambigOptions.length === 0) {
      setDisambigOptions(ambig);
      return; // wait for user to pick which one they mean
    }
    setDisambigOptions([]); // clear once resolved
    setLoading(true);setReport(null);setError("");setPins([]);setStreamChars(0);
    try{
      const cacheKey="analyze_"+loc.toLowerCase().trim().replace(/[^a-z0-9]+/g,"_");
      const res=await fetch(API_ENDPOINT,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:5500,temperature:0,system:SYS,
          messages:[{role:"user",content:`Analyze for land investment: ${loc}, India`}],
          cacheKey,cacheType:"analyze"}),
      });
      const raw=await res.text();
      let d=null; try{ d=JSON.parse(raw); }catch{}
      if(!res.ok){
        const msg=d?.error?.message||raw.slice(0,200)||"No response body.";
        setError(`Request failed (HTTP ${res.status}). ${msg}`);setLoading(false);return;
      }
      if(d?.error){setError("API: "+d.error.message);setLoading(false);return;}
      const text=d?.content?.map(b=>b.text||"").join("")||"";
      const parsed=parseJSON(text);
      if(parsed&&!Array.isArray(parsed)){
        setReport(parsed);
        if(parsed.lat&&parsed.lng) setPins([{...parsed,location:parsed.location_name}]);
      } else setError("Parse failed. Raw: "+text.slice(0,300));
    }catch(e){setError("Error: "+e.message);}
    setLoading(false);
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fff",borderRadius:12,border:`1px solid ${C.border}`,padding:"16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:14,color:C.dark}}>📍 Analyze Any Location</div>
          {onClear&&<button onClick={onClear} style={{background:"none",border:"none",color:C.blue,cursor:"pointer",fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:500}}>← Back to map</button>}
        </div>
        <div style={{display:"flex",gap:7}}>
          <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doAnalyze()}
            style={{...IS,flex:1}} placeholder="e.g. Whitefield, Bengaluru or Sohna, Haryana"/>
          <button onClick={()=>doAnalyze()} disabled={loading||!q.trim()}
            style={{background:loading?C.muted:C.navy,color:"#fff",border:"none",borderRadius:8,padding:"0 15px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,cursor:loading?"default":"pointer",whiteSpace:"nowrap"}}>
            {loading?"…":"Analyze →"}
          </button>
        </div>
        <div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:5}}>
          {(()=>{
            const POOL=["Kanakapura, Karnataka","Anekal, Karnataka","Devanahalli, Karnataka","Dholera, Gujarat","Sohna, Haryana","Amaravati, Andhra Pradesh","Hosur, Tamil Nadu","Panvel, Maharashtra","Whitefield, Bengaluru","Electronic City, Bengaluru","Sarjapur, Bengaluru","Hadapsar, Pune","Hinjewadi, Pune","Wagholi, Pune","Gachibowli, Hyderabad","Kompally, Hyderabad","Sholinganallur, Chennai","Tambaram, Chennai","Dwarka, Delhi","Noida Extension, UP","Nelamangala, Karnataka","Bhiwadi, Rajasthan","Manesar, Haryana","Yelahanka, Bengaluru","Attibele, Karnataka","Jigani, Karnataka","Talegaon, Pune","Adibatla, Hyderabad","Navi Mumbai, Maharashtra","Rajarhat, West Bengal","Aerocity, Delhi","Tumkur, Karnataka","Mysuru, Karnataka","Coimbatore, Tamil Nadu","Siruseri, Tamil Nadu","Madhavaram, Chennai"];
            const seed=Math.floor(Date.now()/600000);
            const out=[];const used=new Set();let x=(seed*1664525+1013904223)>>>0;
            while(out.length<6){x=(x*1664525+1013904223)>>>0;const i=x%POOL.length;if(!used.has(i)){used.add(i);out.push(POOL[i]);}}
            return out.map(s=>(
              <button key={s} onClick={()=>{setQ(s);doAnalyze(s);}}
                style={{background:C.lightBlue,color:C.blue,border:`1px solid #BFDBFE`,borderRadius:20,padding:"3px 9px",fontFamily:"Inter,sans-serif",fontSize:11,cursor:"pointer",fontWeight:500}}>{s}</button>
            ));
          })()}
        </div>
      </div>
      {loading&&(
        <div style={{textAlign:"center",padding:"34px 20px",fontFamily:"Inter,sans-serif",color:C.muted,fontSize:13}}>
          <div style={{fontSize:22,marginBottom:8}}>🔍</div>
          <div style={{fontWeight:600,color:C.dark,marginBottom:3}}>Analyzing {q}…</div>
          <div style={{fontSize:11,marginBottom:10}}>
            {streamChars<3000?"Scanning infrastructure, news signals & economic data":
             streamChars<9000?"Reading growth signals…":
             streamChars<18000?"Compiling civic & traffic intelligence…":
             streamChars<30000?"Building price history & forecasts…":
             "Still working — detailed reports can take up to a couple of minutes"}
          </div>
          {/* Indeterminate progress animation — we don't have real byte-level
              feedback from the API (non-streaming request), so this is an
              honest "still working" indicator rather than a precise percentage. */}
          <div style={{width:"100%",maxWidth:220,height:5,background:C.border,borderRadius:3,margin:"0 auto",overflow:"hidden",position:"relative"}}>
            <div style={{position:"absolute",height:"100%",width:"40%",background:C.blue,borderRadius:3,
              animation:"indeterminate 1.4s ease-in-out infinite"}}/>
          </div>
          <style>{`@keyframes indeterminate{0%{left:-40%}100%{left:100%}}`}</style>
        </div>
      )}
      {/* Disambiguation UI — shown when the searched name exists in multiple
           parts of a city. User picks which one before analysis runs. */}
      {disambigOptions.length>0&&(
        <div style={{background:"#EFF6FF",borderRadius:10,border:"1px solid #BFDBFE",padding:"14px"}}>
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:"#1D4ED8",marginBottom:4}}>
            📍 Which {q.trim()} do you mean?
          </div>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#1E40AF",marginBottom:10}}>
            Multiple localities share this name. Pick the one you're interested in:
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {disambigOptions.map((opt,i)=>(
              <button key={i} onClick={()=>{setQ(opt);setDisambigOptions([]);doAnalyze(opt);}}
                style={{background:"#fff",border:"1.5px solid #BFDBFE",borderRadius:8,
                  padding:"10px 13px",textAlign:"left",cursor:"pointer",
                  fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,
                  lineHeight:1.5}}>
                {opt}
              </button>
            ))}
            <button onClick={()=>setDisambigOptions([])}
              style={{background:"none",border:"none",color:C.muted,fontFamily:"Inter,sans-serif",
                fontSize:11,cursor:"pointer",textAlign:"left",padding:"4px 0"}}>
              Never mind, search "{q}" as-is →
            </button>
          </div>
        </div>
      )}
      {error&&<div style={{color:C.red,fontFamily:"Inter,sans-serif",fontSize:11,padding:"9px 13px",background:"#FFF5F5",borderRadius:8,wordBreak:"break-all"}}>{error}</div>}
      {report&&(
        <>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark}}>🗺️ {report.location_name} on India Growth Map</div>
          <MapView pins={pins} selectedState={report.state} height={270} focusLat={report.lat} focusLng={report.lng} focusZoom={5}/>
          <ReportCard data={report} pins={pins}/>
        </>
      )}
    </div>
  );
}

function HomeTab({onStateSelect,onNavigate}){
  const [view,setView]=useState("search"); // "search" (default landing) or "map" (opened via link below)
  const [q,setQ]=useState("");

  // Flatten the curated city/area clusters across every state into one ranked
  // list — these are real named localities with real scores (see
  // REGION_CLUSTERS above), not a single hardcoded "top pick" like before.
  const topCities=useMemo(()=>{
    const flat=[];
    Object.entries(REGION_CLUSTERS).forEach(([state,arr])=>{
      arr.forEach(c=>flat.push({...c,state}));
    });
    return flat.sort((a,b)=>b.score-a.score).slice(0,12);
  },[]);

  const goAnalyze=(loc)=>{
    if(!loc.trim()) return;
    onStateSelect(loc.trim()); // re-uses the existing handleStateClick flow: sets analyzeQuery + switches tab
  };

  if(view==="map"){
    return(
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{fontFamily:"serif",fontSize:16,color:C.dark}}>Browse by state</div>
          <button onClick={()=>setView("search")} style={{background:"none",border:"none",color:C.blue,
            cursor:"pointer",fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600}}>← Back to search</button>
        </div>
        <MapView onStateClick={onStateSelect} height={420}/>
        <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,textAlign:"center"}}>
          ☝️ Click any state · Hover to preview growth score · Green = high growth opportunity
        </div>
      </div>
    );
  }

  return(
    <div style={{display:"flex",flexDirection:"column",gap:0}}>
      {/* Search-first hero — replaces the map as the landing focus. The map
          was the first thing people saw before, with no clear next action;
          this leads with the one question the app actually answers. */}
      <div style={{background:"linear-gradient(180deg,#0F1B2D,#16243A)",borderRadius:14,
        padding:"30px 18px 24px",textAlign:"center",marginBottom:18}}>
        <div style={{color:"#F8FAFB",fontFamily:"serif",fontSize:19,lineHeight:1.35,marginBottom:7}}>
          Where are you<br/>looking to invest?
        </div>
        <div style={{color:"#94A3B8",fontFamily:"Inter,sans-serif",fontSize:12,marginBottom:18}}>
          Type any locality in India to get a growth score
        </div>
        <div style={{background:"#fff",borderRadius:12,padding:5,display:"flex",gap:5,
          boxShadow:"0 8px 22px rgba(0,0,0,0.25)"}}>
          <input value={q} onChange={e=>setQ(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter") goAnalyze(q);}}
            placeholder="Whitefield, Bengaluru"
            style={{flex:1,border:"none",outline:"none",padding:"10px 11px",fontSize:13,
              color:C.dark,fontFamily:"Inter,sans-serif",borderRadius:8}}/>
          <button onClick={()=>goAnalyze(q)} style={{background:C.navy,color:"#fff",border:"none",
            borderRadius:8,padding:"0 15px",fontSize:12.5,fontWeight:700,cursor:"pointer",
            fontFamily:"Inter,sans-serif",whiteSpace:"nowrap"}}>Analyze →</button>
        </div>
        <div style={{display:"flex",gap:5,marginTop:10,flexWrap:"wrap",justifyContent:"center"}}>
          {["Dholera, Gujarat","Aerocity, Delhi","Sarjapur, Bengaluru"].map(s=>(
            <button key={s} onClick={()=>goAnalyze(s)} style={{background:"rgba(255,255,255,0.1)",
              color:"#CBD5E1",fontSize:10.5,padding:"4px 10px",borderRadius:13,
              border:"1px solid rgba(255,255,255,0.15)",cursor:"pointer",fontFamily:"Inter,sans-serif"}}>{s}</button>
          ))}
        </div>
      </div>

      {/* Secondary tools — present but visually quiet, since search is the
          primary path now and these are alternate entry points. */}
      <div style={{fontFamily:"Inter,sans-serif",fontSize:10.5,fontWeight:700,color:C.muted,
        textTransform:"uppercase",letterSpacing:0.4,marginBottom:9}}>Or use a different tool</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(96px,1fr))",gap:8,marginBottom:18}}>
        {[
          {tab:"screen",icon:"🎯",title:"Screener",desc:"Find opportunities"},
          {tab:"pricer",icon:"🏘️",title:"Pricer",desc:"Value a property"},
        ].map(f=>(
          <button key={f.tab} onClick={()=>onNavigate(f.tab)}
            style={{background:C.bg,border:"1px solid "+C.border,borderRadius:10,
              padding:"12px 8px",cursor:"pointer",textAlign:"center",
              display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
            <span style={{fontSize:18}}>{f.icon}</span>
            <span style={{fontFamily:"serif",fontSize:11.5,color:C.dark}}>{f.title}</span>
            <span style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted}}>{f.desc}</span>
          </button>
        ))}
        <button onClick={()=>setView("map")}
          style={{background:C.bg,border:"1px solid "+C.border,borderRadius:10,
            padding:"12px 8px",cursor:"pointer",textAlign:"center",
            display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
          <span style={{fontSize:18}}>🗺️</span>
          <span style={{fontFamily:"serif",fontSize:11.5,color:C.dark}}>Map</span>
          <span style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted}}>Browse states</span>
        </button>
      </div>

      {/* Top investment areas — real ranked list pulled from curated city/area
          data across every state (REGION_CLUSTERS), not a single hardcoded
          pick. Tapping any row jumps straight into a full Analyze report. */}
      <div style={{fontFamily:"Inter,sans-serif",fontSize:10.5,fontWeight:700,color:C.muted,
        textTransform:"uppercase",letterSpacing:0.4,marginBottom:9}}>Top investment areas across India</div>
      <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:18}}>
        {topCities.map((c,i)=>(
          <button key={c.name} onClick={()=>goAnalyze(c.name.split(" (")[0]+", "+c.state)}
            style={{display:"flex",alignItems:"center",gap:10,background:"#fff",
              border:"1px solid "+C.border,borderRadius:10,padding:"10px 12px",
              cursor:"pointer",textAlign:"left",width:"100%"}}>
            <span style={{fontFamily:"serif",fontSize:12,color:"#CBD5E1",width:16,flexShrink:0}}>{i+1}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontFamily:"serif",fontSize:13,color:C.dark,whiteSpace:"nowrap",
                overflow:"hidden",textOverflow:"ellipsis"}}>{c.name}</div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:10.5,color:C.muted}}>{c.state}</div>
            </div>
            <span style={{flexShrink:0,background:scoreColor(c.score),color:"#fff",borderRadius:5,
              padding:"3px 8px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:11}}>{c.score}</span>
          </button>
        ))}
      </div>

      <button onClick={()=>onNavigate("pricer")}
        style={{display:"flex",alignItems:"center",gap:10,background:"#fff",
          border:"1px solid #E2E8F0",borderRadius:10,padding:"11px 13px",
          cursor:"pointer",textAlign:"left",width:"100%"}}>
        <span style={{fontSize:18,flexShrink:0}}>📋</span>
        <div style={{flex:1}}>
          <div style={{fontFamily:"serif",fontSize:13,color:"#1E293B"}}>Check RERA registration</div>
          <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#64748B",marginTop:1}}>
            Search by project name or builder — no reg number needed
          </div>
        </div>
        <span style={{color:"#94A3B8",fontSize:14,flexShrink:0}}>→</span>
      </button>

      {topCities[0]&&(
        <div style={{background:"#FFFBEB",borderRadius:9,border:`1px solid #FDE68A`,padding:"11px 13px",
          fontFamily:"Inter,sans-serif",fontSize:12,color:"#92400E"}}>
          🔮 <strong>#1 right now — {topCities[0].name} ({topCities[0].score}/100, {topCities[0].state}).</strong>{" "}
          Tap to run a full analysis.
        </div>
      )}
    </div>
  );
}



// ─── PROPERTY PRICER (Apartments + Villas + Plots) ──────────────────────────

// ── Amenity Database (80+ with scoring weights) ──────────────────────────────
const AMENITY_CATEGORIES = {
  "Essential (High Impact)": {
    weight: 1.0,
    items: [
      {id:"security_24x7", label:"24×7 Security + Guard", premium:120, essential:true},
      {id:"cctv", label:"CCTV Surveillance", premium:60, essential:true},
      {id:"power_backup_full", label:"Full Power Backup (100%)", premium:180, essential:true},
      {id:"power_backup_partial", label:"Partial Power Backup (Common)", premium:80, essential:true},
      {id:"lift", label:"Elevator / Lift", premium:100, essential:true},
      {id:"water_24x7", label:"24×7 Water Supply", premium:90, essential:true},
      {id:"covered_parking", label:"Covered Car Parking", premium:200, essential:true},
      {id:"open_parking", label:"Open Parking", premium:80, essential:true},
      {id:"intercom", label:"Video Intercom / Door Bell", premium:50, essential:true},
      {id:"fire_safety", label:"Fire Safety Systems", premium:70, essential:true},
      {id:"sewage_treatment", label:"Sewage Treatment Plant", premium:55, essential:true},
      {id:"rainwater", label:"Rainwater Harvesting", premium:50, essential:true},
    ]
  },
  "Sports & Fitness": {
    weight: 0.85,
    items: [
      {id:"gym", label:"Gymnasium / Fitness Center", premium:150},
      {id:"swimming_pool", label:"Swimming Pool", premium:220},
      {id:"infinity_pool", label:"Infinity Pool", premium:350},
      {id:"kids_pool", label:"Kids Pool", premium:80},
      {id:"badminton", label:"Badminton Court", premium:90},
      {id:"tennis", label:"Tennis Court", premium:130},
      {id:"basketball", label:"Basketball Court", premium:100},
      {id:"squash", label:"Squash Court", premium:110},
      {id:"cricket_net", label:"Cricket Nets / Pitch", premium:80},
      {id:"yoga_studio", label:"Yoga / Aerobics Studio", premium:90},
      {id:"indoor_games", label:"Indoor Games Room", premium:70},
      {id:"jogging_track", label:"Jogging Track", premium:100},
      {id:"cycling_track", label:"Cycling Track", premium:85},
      {id:"skating_rink", label:"Skating Rink", premium:75},
      {id:"golf_simulator", label:"Golf Simulator", premium:200},
      {id:"rock_climbing", label:"Rock Climbing Wall", premium:80},
    ]
  },
  "Wellness & Spa": {
    weight: 0.80,
    items: [
      {id:"spa", label:"Spa & Massage Center", premium:180},
      {id:"sauna", label:"Sauna / Steam Room", premium:130},
      {id:"jacuzzi", label:"Jacuzzi", premium:120},
      {id:"meditation_room", label:"Meditation Room", premium:60},
      {id:"ayurveda", label:"Ayurveda / Wellness Center", premium:140},
    ]
  },
  "Community & Social": {
    weight: 0.75,
    items: [
      {id:"clubhouse", label:"Clubhouse", premium:170},
      {id:"banquet_hall", label:"Banquet / Party Hall", premium:130},
      {id:"multipurpose_hall", label:"Multipurpose Hall", premium:100},
      {id:"amphitheater", label:"Open Air Amphitheater", premium:80},
      {id:"library", label:"Library / Reading Room", premium:60},
      {id:"coworking", label:"Co-Working Space", premium:100},
      {id:"conference_room", label:"Conference Room", premium:80},
      {id:"business_center", label:"Business Center", premium:90},
    ]
  },
  "Kids & Family": {
    weight: 0.80,
    items: [
      {id:"kids_play", label:"Children's Play Area", premium:80},
      {id:"kids_indoor", label:"Kids Indoor Play Zone", premium:90},
      {id:"creche", label:"Crèche / Day Care", premium:100},
      {id:"school_bus", label:"School Bus Pickup Point", premium:40},
      {id:"tot_lot", label:"Tot Lot / Toddler Zone", premium:50},
    ]
  },
  "Green & Landscape": {
    weight: 0.70,
    items: [
      {id:"landscape_garden", label:"Landscaped Garden", premium:100},
      {id:"rooftop_garden", label:"Rooftop Garden / Terrace", premium:130},
      {id:"herb_garden", label:"Herb / Kitchen Garden", premium:40},
      {id:"forest_trail", label:"Nature / Forest Trail", premium:80},
      {id:"water_feature", label:"Water Feature / Fountain", premium:60},
      {id:"organic_farming", label:"Organic Farming Plot", premium:50},
    ]
  },
  "Smart & Tech": {
    weight: 0.75,
    items: [
      {id:"smart_home", label:"Smart Home Automation", premium:200},
      {id:"ev_charging", label:"EV Charging Points", premium:80},
      {id:"solar_power", label:"Solar Power System", premium:120},
      {id:"app_control", label:"Society Management App", premium:50},
      {id:"biometric", label:"Biometric / RFID Access", premium:60},
      {id:"fiber_internet", label:"High Speed Fiber Internet", premium:70},
      {id:"cctv_ai", label:"AI-based CCTV Analytics", premium:90},
    ]
  },
  "Retail & Services": {
    weight: 0.55,
    items: [
      {id:"mini_market", label:"Mini Supermarket / Kirana", premium:60},
      {id:"pharmacy", label:"Pharmacy / Medical Store", premium:70},
      {id:"salon", label:"Salon / Grooming Center", premium:40},
      {id:"laundry", label:"Laundry Service", premium:40},
      {id:"atm", label:"ATM On-Premises", premium:30},
      {id:"concierge", label:"Concierge Service", premium:120},
      {id:"cafe_inside", label:"Café Inside Complex", premium:30},
      {id:"food_court", label:"Food Court", premium:45},
    ]
  },
  "Premium / Luxury": {
    weight: 0.90,
    items: [
      {id:"private_elevator", label:"Private / Personal Elevator", premium:400},
      {id:"sky_lounge", label:"Sky Lounge / Sky Deck", premium:250},
      {id:"private_pool", label:"Private Pool (Villa/Penthouse)", premium:500},
      {id:"home_theater", label:"Home Theater Room", premium:200},
      {id:"wine_cellar", label:"Wine Cellar", premium:150},
      {id:"panic_room", label:"Panic Room", premium:120},
      {id:"helipad", label:"Helipad", premium:300},
      {id:"butler_service", label:"Butler / Valet Service", premium:250},
    ]
  },
};

const ALL_AMENITIES = Object.entries(AMENITY_CATEGORIES).flatMap(([cat, data]) =>
  data.items.map(item => ({...item, category: cat, weight: data.weight}))
);

// ── Developer Tiers ───────────────────────────────────────────────────────────
const DEVELOPER_TIERS = {
  "Ultra Premium (Sobha, Prestige Luxury, Lodha Luxury, DLF Ultra)": 1.35,
  "Premium (Brigade, Godrej, TATA, Mahindra, Puravankara)": 1.18,
  "Mid-Premium (Shapoorji, Embassy, Assetz, Salarpuria)": 1.08,
  "Standard Builder (Local reputed)": 1.0,
  "Budget / Unknown Builder": 0.87,
};

// ── Property Segments ─────────────────────────────────────────────────────────
const PROPERTY_TYPES = ["Apartment / Flat", "Villa / Independent House", "Plot / Land", "Penthouse", "Row House / Townhouse"];
const BHK_OPTIONS = ["Studio", "1 BHK", "1.5 BHK", "2 BHK", "2.5 BHK", "3 BHK", "3.5 BHK", "4 BHK", "5 BHK", "6 BHK+", "Villa - 2BHK", "Villa - 3BHK", "Villa - 4BHK", "Villa - 5BHK+"];
const CONSTRUCTION_STATUS = ["Ready to Move / Possession", "Under Construction (within 1 yr)", "Under Construction (1-2 yrs)", "Under Construction (2-3 yrs)", "Pre-Launch / Pre-Construction"];
const AREA_TYPES = ["Super Built-up Area", "Built-up Area", "Carpet Area"];
const BUILDING_TYPES = ["High Rise (20+ floors)", "Mid Rise (8-19 floors)", "Low Rise (4-7 floors)", "Standalone / Independent", "Gated Villa Community", "Plotted Development"];
const COMMON_WALLS = ["No Common Walls (Corner/End Unit)", "1 Common Wall", "2 Common Walls (Middle Unit)", "3 Common Walls"];
const WATER_QUALITY = ["Borewell (Hard Water)", "Corporation Supply", "Treated / RO Water", "Mixed (Borewell + Corp)", "24×7 Treated Water"];

// ── Construction discount/premium factors ────────────────────────────────────
const CONSTRUCTION_FACTOR = {
  "Ready to Move / Possession": 1.0,
  "Under Construction (within 1 yr)": 0.92,
  "Under Construction (1-2 yrs)": 0.85,
  "Under Construction (2-3 yrs)": 0.80,
  "Pre-Launch / Pre-Construction": 0.73,
};

const COMPLETION_APPRECIATION = {
  "Ready to Move / Possession": 0,
  "Under Construction (within 1 yr)": 12,
  "Under Construction (1-2 yrs)": 22,
  "Under Construction (2-3 yrs)": 32,
  "Pre-Launch / Pre-Construction": 45,
};

// ── Civic Score Factors ───────────────────────────────────────────────────────
const CIVIC_FACTORS = [
  {id:"road_quality",          label:"Road Quality & Maintenance",      positive:true,  score:8},
  {id:"garbage_mgmt",          label:"Garbage Collection & SWM",        positive:true,  score:5},
  {id:"streetlight",           label:"Street Lighting",                 positive:true,  score:4},
  {id:"sewage_good",           label:"No Sewage / Flooding Issues",     positive:true,  score:6},
  {id:"park_public",           label:"Public Parks Nearby",             positive:true,  score:5},
  {id:"police_presence",       label:"Police Station / Patrolling",     positive:true,  score:4},
  {id:"noise_pollution",       label:"Noise Pollution Issues",          positive:false, score:-5},
  {id:"air_quality",           label:"Air Quality (AQI issues)",        positive:false, score:-6},
  {id:"stray_animals",         label:"Stray Animal Problem",            positive:false, score:-3},
  {id:"illegal_constructions", label:"Illegal Constructions Nearby",    positive:false, score:-8},
  {id:"flooding",              label:"Flooding / Waterlogging in Rains",positive:false, score:-7},
  {id:"power_cuts",            label:"Frequent Power Cuts",             positive:false, score:-4},
];

// ── Infra Proximity ───────────────────────────────────────────────────────────
const INFRA_ITEMS = [
  {id:"hospital_500m", label:"Hospital within 500m", premium:60, icon:"🏥"},
  {id:"hospital_2km", label:"Hospital within 2 km", premium:40, icon:"🏥"},
  {id:"clinic_nearby", label:"Clinic / Doctor nearby", premium:30, icon:"🩺"},
  {id:"pharmacy_nearby", label:"Pharmacy nearby", premium:25, icon:"💊"},
  {id:"school_1km", label:"School within 1 km", premium:70, icon:"🏫"},
  {id:"school_3km", label:"School within 3 km", premium:40, icon:"🏫"},
  {id:"college_3km", label:"College within 3 km", premium:35, icon:"🎓"},
  {id:"supermarket_500m", label:"Supermarket within 500m", premium:50, icon:"🛒"},
  {id:"mall_3km", label:"Mall / Shopping Center 3km", premium:45, icon:"🏬"},
  {id:"restaurant_cluster", label:"Restaurant Cluster nearby", premium:30, icon:"🍽️"},
  {id:"hotel_nearby", label:"Hotel / Business Stay nearby", premium:20, icon:"🏨"},
  {id:"bank_atm", label:"Bank / ATM within 500m", premium:30, icon:"🏦"},
  {id:"metro_500m", label:"Metro Station within 500m", premium:180, icon:"🚇"},
  {id:"metro_2km", label:"Metro Station within 2 km", premium:100, icon:"🚇"},
  {id:"bus_stop_300m", label:"Bus Stop within 300m", premium:50, icon:"🚌"},
  {id:"railway_3km", label:"Railway Station within 3 km", premium:70, icon:"🚆"},
  {id:"highway_5km", label:"Highway / Expressway within 5 km", premium:60, icon:"🛣️"},
  {id:"it_park_5km", label:"IT Park / SEZ within 5 km", premium:90, icon:"💼"},
  {id:"petrol_pump", label:"Petrol Pump nearby", premium:20, icon:"⛽"},
  {id:"place_of_worship", label:"Temple / Mosque / Church nearby", premium:20, icon:"🛕"},
];

// ── Realistic city-tier base rates (₹/sqft) — informed by 2025-26 market data ──
const CITY_TIER_RATES = {
  tier1: {apartment:9500, villa:12000, plot:4500, penthouse:18000,
    cities:["mumbai","bengaluru","bangalore","delhi","gurgaon","gurugram","noida","hyderabad",
      "chennai","pune","kolkata","navi mumbai","thane","ghaziabad","faridabad","new delhi"]},
  tier2: {apartment:5500, villa:6800, plot:2200, penthouse:9500,
    cities:["ahmedabad","jaipur","lucknow","kochi","cochin","chandigarh","indore","coimbatore",
      "nagpur","vadodara","visakhapatnam","vizag","surat","bhopal","patna","kanpur","kozhikode",
      "thiruvananthapuram","trivandrum","mysore","mysuru"]},
  tier3: {apartment:3800, villa:4500, plot:1400, penthouse:6500,
    cities:["mangalore","mangaluru","madurai","tiruchirappalli","trichy","salem","vijayawada",
      "guntur","nashik","aurangabad","raipur","ranchi","jamshedpur","dehradun","mohali",
      "panchkula","gandhinagar","rajkot","jodhpur","udaipur","amritsar","ludhiana","varanasi",
      "agra","meerut","guwahati","bhubaneswar","siliguri","durgapur","jalandhar"]},
  tier4: {apartment:2500, villa:2800, plot:700, penthouse:4200, cities:[]},
};

function getCityTierRate(cityInput, propertyKind){
  const c = (cityInput||"").toLowerCase().trim();
  for(const tier of ["tier1","tier2","tier3"]){
    if(CITY_TIER_RATES[tier].cities.some(name=>c.includes(name))){
      return CITY_TIER_RATES[tier][propertyKind] || CITY_TIER_RATES[tier].apartment;
    }
  }
  return CITY_TIER_RATES.tier4[propertyKind] || CITY_TIER_RATES.tier4.apartment;
}

// ── Property tax rates by state (approx annual % of assessed/market value) ──
const PROPERTY_TAX_RATES = {
  "karnataka":0.20, "maharashtra":0.30, "tamil nadu":0.15, "telangana":0.20,
  "delhi":0.25, "haryana":0.22, "uttar pradesh":0.18, "west bengal":0.15,
  "gujarat":0.18, "rajasthan":0.16, "kerala":0.14, "punjab":0.17,
  "andhra pradesh":0.18, "madhya pradesh":0.15, "bihar":0.12, "odisha":0.13,
  "default":0.18,
};

function getPropertyTaxRate(cityOrState){
  const c=(cityOrState||"").toLowerCase();
  for(const state in PROPERTY_TAX_RATES){
    if(state!=="default" && c.includes(state)) return PROPERTY_TAX_RATES[state];
  }
  // City→state inference for common cities
  const cityStateMap = {
    "bengaluru":"karnataka","bangalore":"karnataka","mysore":"karnataka","mysuru":"karnataka",
    "mumbai":"maharashtra","pune":"maharashtra","nagpur":"maharashtra","nashik":"maharashtra",
    "chennai":"tamil nadu","coimbatore":"tamil nadu","madurai":"tamil nadu",
    "hyderabad":"telangana","warangal":"telangana",
    "delhi":"delhi","new delhi":"delhi",
    "gurgaon":"haryana","gurugram":"haryana","faridabad":"haryana",
    "noida":"uttar pradesh","lucknow":"uttar pradesh","kanpur":"uttar pradesh","agra":"uttar pradesh",
    "kolkata":"west bengal","siliguri":"west bengal",
    "ahmedabad":"gujarat","surat":"gujarat","vadodara":"gujarat","rajkot":"gujarat",
    "jaipur":"rajasthan","jodhpur":"rajasthan","udaipur":"rajasthan",
    "kochi":"kerala","cochin":"kerala","thiruvananthapuram":"kerala","trivandrum":"kerala",
    "chandigarh":"punjab","amritsar":"punjab","ludhiana":"punjab","jalandhar":"punjab",
    "visakhapatnam":"andhra pradesh","vizag":"andhra pradesh","vijayawada":"andhra pradesh",
    "indore":"madhya pradesh","bhopal":"madhya pradesh",
    "patna":"bihar","bhubaneswar":"odisha",
  };
  for(const city in cityStateMap){
    if(c.includes(city)) return PROPERTY_TAX_RATES[cityStateMap[city]];
  }
  return PROPERTY_TAX_RATES.default;
}


// ── Nationwide land/property approval types — covers all major states/UTs ──
const APPROVAL_TYPES = {
  "Karnataka": ["BBMP A Khata","BBMP B Khata","BBMP E Khata","Panchayat Khata","BDA Approved","BMRDA Approved","KIADB Approved","Revenue Site (Akrama-Sakrama pending)","Gram Panchayat"],
  "Tamil Nadu": ["CMDA Approved","DTCP Approved","Corporation Property","Panchayat","Layout Approved by LPA","RERA Registered"],
  "Telangana": ["GHMC Approved","HMDA Approved","Panchayat","LRS Approved","TS-RERA Registered","Dharani Portal Registered"],
  "Andhra Pradesh": ["GVMC/Municipal Approved","CRDA/APCRDA Approved","Panchayat","LRS Approved","AP-RERA Registered"],
  "Maharashtra": ["BMC Approved","MHADA","SRA","PMC/PCMC Approved","PMRDA/MMRDA","CIDCO","NA Plot (Non-Agricultural)","Gaothan Property","MahaRERA Registered"],
  "Delhi NCR": ["DDA Approved","HRERA Registered (Haryana)","UP-RERA Registered","Lal Dora","Farm House Zone","Municipal Corporation Approved","L-Zone/Dwarka Expressway Belt"],
  "Haryana": ["HUDA/HSVP Approved","DTP Approved","HRERA Registered","Lal Dora","Gram Panchayat","Licensed Colony"],
  "Uttar Pradesh": ["UP-RERA Registered","Development Authority Approved (e.g. NOIDA/GNIDA)","Gram Panchayat","Nazul Land","Freehold Converted"],
  "West Bengal": ["KMC Approved","HIDCO/NKDA (New Town)","Panchayat","WB-RERA Registered","Bagan/Plotted Land"],
  "Gujarat": ["AMC/Municipal Approved","GUDA/AUDA Approved","Panchayat","NA Permission Granted","GujRERA Registered","Gunthan/Old Tenure Land"],
  "Rajasthan": ["JDA/UIT Approved","Municipal Corporation Approved","Panchayat","Patta Land","RERA Rajasthan Registered"],
  "Kerala": ["Corporation/Municipality Approved","Panchayat","Nilam/Paddy Land (conversion needed)","K-RERA Registered","Possession Certificate Only"],
  "Punjab": ["GMADA/PUDA Approved","Municipal Corporation Approved","Panchayat","PRERA Registered","Lal Lakir (village land)"],
  "Madhya Pradesh": ["Municipal Corporation Approved","Development Authority Approved","Panchayat","Diversion Land (converted)","MP-RERA Registered"],
  "Bihar": ["Municipal Corporation Approved","RERA Bihar Registered","Panchayat","Raiyati Land","Gairmazarua Land"],
  "Odisha": ["BDA/Municipal Approved","Panchayat","RERA Odisha Registered","Patta Land","Sabik/Hal Khatian"],
  "Other / Generic": ["Municipal Corporation Approved","Town Planning Approved","Panchayat","Revenue Site","Court Order Property","Private Layout Approved","RERA Registered"],
};

// Auto-detect state from any free-text city input
const CITY_TO_STATE = {
  "bengaluru":"Karnataka","bangalore":"Karnataka","mysore":"Karnataka","mysuru":"Karnataka",
  "mangalore":"Karnataka","mangaluru":"Karnataka","hubli":"Karnataka","belgaum":"Karnataka",
  "chennai":"Tamil Nadu","coimbatore":"Tamil Nadu","madurai":"Tamil Nadu","trichy":"Tamil Nadu",
  "tiruchirappalli":"Tamil Nadu","salem":"Tamil Nadu","tirunelveli":"Tamil Nadu",
  "hyderabad":"Telangana","warangal":"Telangana","secunderabad":"Telangana",
  "visakhapatnam":"Andhra Pradesh","vizag":"Andhra Pradesh","vijayawada":"Andhra Pradesh",
  "guntur":"Andhra Pradesh","tirupati":"Andhra Pradesh","amaravati":"Andhra Pradesh",
  "mumbai":"Maharashtra","pune":"Maharashtra","nagpur":"Maharashtra","nashik":"Maharashtra",
  "thane":"Maharashtra","navi mumbai":"Maharashtra","aurangabad":"Maharashtra","pimpri":"Maharashtra",
  "delhi":"Delhi NCR","new delhi":"Delhi NCR","dwarka":"Delhi NCR",
  "gurgaon":"Haryana","gurugram":"Haryana","faridabad":"Haryana","panchkula":"Haryana",
  "noida":"Uttar Pradesh","ghaziabad":"Uttar Pradesh","lucknow":"Uttar Pradesh","kanpur":"Uttar Pradesh",
  "agra":"Uttar Pradesh","varanasi":"Uttar Pradesh","meerut":"Uttar Pradesh","greater noida":"Uttar Pradesh",
  "kolkata":"West Bengal","siliguri":"West Bengal","durgapur":"West Bengal","howrah":"West Bengal",
  "ahmedabad":"Gujarat","surat":"Gujarat","vadodara":"Gujarat","rajkot":"Gujarat","gandhinagar":"Gujarat",
  "jaipur":"Rajasthan","jodhpur":"Rajasthan","udaipur":"Rajasthan","kota":"Rajasthan",
  "kochi":"Kerala","cochin":"Kerala","thiruvananthapuram":"Kerala","trivandrum":"Kerala","kozhikode":"Kerala",
  "chandigarh":"Punjab","amritsar":"Punjab","ludhiana":"Punjab","jalandhar":"Punjab","mohali":"Punjab",
  "indore":"Madhya Pradesh","bhopal":"Madhya Pradesh","jabalpur":"Madhya Pradesh","gwalior":"Madhya Pradesh",
  "patna":"Bihar","gaya":"Bihar","muzaffarpur":"Bihar",
  "bhubaneswar":"Odisha","cuttack":"Odisha","puri":"Odisha",
};

function detectStateFromCity(cityInput){
  const c=(cityInput||"").toLowerCase().trim();
  for(const city in CITY_TO_STATE){
    if(c.includes(city)) return CITY_TO_STATE[city];
  }
  return "Other / Generic";
}

const APPROVAL_IMPACT = {
  "BBMP A Khata":1.0,"BBMP B Khata":0.88,"BBMP E Khata":0.82,"Panchayat Khata":0.78,
  "BDA Approved":1.05,"BMRDA Approved":0.98,"KIADB Approved":1.02,
  "Revenue Site (Akrama-Sakrama pending)":0.72,"Gram Panchayat":0.75,
  "CMDA Approved":1.0,"DTCP Approved":0.97,"Corporation Property":1.02,"RERA Registered":1.03,
  "GHMC Approved":1.0,"HMDA Approved":0.98,"LRS Approved":0.88,"TS-RERA Registered":1.02,"Dharani Portal Registered":1.0,
  "GVMC/Municipal Approved":1.0,"CRDA/APCRDA Approved":1.04,"AP-RERA Registered":1.02,
  "BMC Approved":1.0,"MHADA":0.90,"SRA":0.80,"PMC/PCMC Approved":1.0,"PMRDA/MMRDA":0.97,
  "CIDCO":1.03,"NA Plot (Non-Agricultural)":0.95,"Gaothan Property":0.70,"MahaRERA Registered":1.02,
  "DDA Approved":1.05,"HRERA Registered (Haryana)":1.02,"UP-RERA Registered":1.02,
  "Lal Dora":0.78,"Farm House Zone":0.85,"Municipal Corporation Approved":1.0,"L-Zone/Dwarka Expressway Belt":0.90,
  "HUDA/HSVP Approved":1.04,"DTP Approved":0.96,"Licensed Colony":1.0,
  "Development Authority Approved (e.g. NOIDA/GNIDA)":1.05,"Nazul Land":0.65,"Freehold Converted":1.0,
  "KMC Approved":1.0,"HIDCO/NKDA (New Town)":1.06,"WB-RERA Registered":1.02,"Bagan/Plotted Land":0.80,
  "AMC/Municipal Approved":1.0,"GUDA/AUDA Approved":1.03,"NA Permission Granted":0.95,
  "GujRERA Registered":1.02,"Gunthan/Old Tenure Land":0.68,
  "JDA/UIT Approved":1.02,"Patta Land":0.85,"RERA Rajasthan Registered":1.02,
  "Corporation/Municipality Approved":1.0,"Nilam/Paddy Land (conversion needed)":0.60,
  "K-RERA Registered":1.02,"Possession Certificate Only":0.70,
  "GMADA/PUDA Approved":1.03,"PRERA Registered":1.02,"Lal Lakir (village land)":0.72,
  "Diversion Land (converted)":0.90,"MP-RERA Registered":1.02,
  "RERA Bihar Registered":1.0,"Raiyati Land":0.75,"Gairmazarua Land":0.55,
  "BDA/Municipal Approved":1.0,"RERA Odisha Registered":1.0,"Sabik/Hal Khatian":0.78,
  "Town Planning Approved":1.0,"Revenue Site":0.72,"Court Order Property":0.62,"Private Layout Approved":0.90,
};



const LEGAL_STATUSES = ["Clear Title","Clear Title - RERA Registered","Disputed Title","Under Litigation","Encumbrance Pending","Loan Not Cleared","Agricultural Land (conversion pending)","Forest Land (restricted)"];
const CONSTRUCTION_QUALITIES = ["Grade A+ (Luxury - Imported Materials)","Grade A (Premium)","Grade B (Standard)","Grade C (Budget)","Under-delivered vs promise"];
const COMMUNITY_TYPES = ["Gated Community","Open Layout","Township","Villa Community","Standalone Building","Mixed Use Development"];
const VENTILATION_OPTIONS = ["Excellent (Cross Ventilation)","Good","Average","Poor (Boxed In)"];
const CITY_GROUPS = Object.keys(APPROVAL_TYPES);


// ─────────────────────────────────────────────────────────────────────────────
// NEW PRICER TAB — Combined design
// Structure:
//   Internal tab A — Quick Check: RERA search → 4 inputs → instant estimate
//   Internal tab B — Full Valuation: 5-step wizard with live amenity pricing
// ─────────────────────────────────────────────────────────────────────────────

function PricerTab(){
  const [mode, setMode] = useState("quick"); // "quick" | "full"

  // ── Shared state (used by both modes) ─────────────────────────────────────
  const [city, setCity]         = useState("Bengaluru");
  const [locality, setLocality] = useState("");
  const [propType, setPropType] = useState("Apartment / Flat");
  const [bhk, setBhk]           = useState("2 BHK");
  const [areaType, setAreaType] = useState("Carpet Area");
  const [area, setArea]         = useState(1200);
  const [plotArea, setPlotArea] = useState(1200);
  const [plotAreaUnit, setPlotAreaUnit] = useState("sqft");
  const [buildingType, setBuildingType] = useState("High Rise (>10 floors)");
  const [totalFloors, setTotalFloors]   = useState(20);
  const [selectedFloor, setSelectedFloor] = useState(7);
  const [totalBlocks, setTotalBlocks]   = useState(3);
  const [commonWalls, setCommonWalls]   = useState("1 Common Wall");
  const [constructionStatus, setConstructionStatus] = useState("Ready to Move / Possession");
  const [completionYear, setCompletionYear] = useState(2026);
  const [developer, setDeveloper]       = useState("Standard Builder (Local reputed)");
  const [customDevPremium, setCustomDevPremium] = useState("");
  const [waterQuality, setWaterQuality] = useState("Corporation Supply");
  const [carParking, setCarParking]     = useState(1);
  const [age, setAge]                   = useState("New (0-2 yrs)");
  const [askingPrice, setAskingPrice]   = useState("");

  // ── Amenity state ──────────────────────────────────────────────────────────
  const [selAmenities, setSelAmenities] = useState([
    "security_24x7","cctv","power_backup_full","lift","covered_parking",
    "water_24x7","intercom","fire_safety","gym","swimming_pool","clubhouse","kids_play","landscape_garden"
  ]);
  const [amenityMode, setAmenityMode]   = useState("select");
  const [amenityCount, setAmenityCount] = useState(20);
  const [expandedCat, setExpandedCat]   = useState("Essential (High Impact)");

  // ── Civic & infra state ────────────────────────────────────────────────────
  const [civicGood, setCivicGood] = useState(["road_quality","streetlight","garbage_mgmt"]);
  const [civicBad,  setCivicBad]  = useState([]);
  const [selInfra, setSelInfra]   = useState(["hospital_2km","school_1km","supermarket_500m","bus_500m","metro_1km"]);

  // ── Pricing / corrections ──────────────────────────────────────────────────
  const [userMinPrice, setUserMinPrice] = useState("");
  const [userMaxPrice, setUserMaxPrice] = useState("");
  const [priceCorrections, setPriceCorrections] = useState([]);

  // ── Legal, quality, views ──────────────────────────────────────────────────
  const [approvalState, setApprovalState]   = useState("");
  const [approvalType, setApprovalType]     = useState("BBMP A Khata");
  const [legalStatus, setLegalStatus]       = useState("Clear Title");
  const [constructionQuality, setConstructionQuality] = useState("Standard (RCC, ISI materials)");
  const [communityType, setCommunityType]   = useState("Gated Community");
  const [ventilation, setVentilation]       = useState("Good (Cross ventilation)");
  const [noBalconies, setNoBalconies]       = useState(1);
  const [totalFlatsInBuilding, setTotalFlatsInBuilding] = useState(120);
  const [hasLakeView, setHasLakeView]       = useState(false);
  const [hasGardenView, setHasGardenView]   = useState(false);
  const [hasParkView, setHasParkView]       = useState(false);
  const [hasCityView, setHasCityView]       = useState(false);
  const [hasDuplex, setHasDuplex]           = useState(false);
  const [hasServantRoom, setHasServantRoom] = useState(false);

  // ── Maintenance & auto-calc ────────────────────────────────────────────────
  const [maintenanceCharge, setMaintenanceCharge]   = useState("");
  const [maintenanceType, setMaintenanceType]       = useState("flat monthly charge");
  const [autoCalc, setAutoCalc]                     = useState(true);
  const [annualMaintenance, setAnnualMaintenance]   = useState("");
  const [annualRepairs, setAnnualRepairs]           = useState("");
  const [propertyTaxAnnual, setPropertyTaxAnnual]   = useState("");
  const [landAppreciationRate, setLandAppreciationRate] = useState(10);

  // ── UDS & Loan ─────────────────────────────────────────────────────────────
  const [udsPercent, setUdsPercent]         = useState("");
  const [totalLandArea, setTotalLandArea]   = useState("");
  const [loanAmount, setLoanAmount]         = useState("");
  const [downPayment, setDownPayment]       = useState("");
  const [loanInterestRate, setLoanInterestRate] = useState(8.5);
  const [loanTenureYears, setLoanTenureYears]   = useState(20);

  // ── RERA search ────────────────────────────────────────────────────────────
  const [reraQuery, setReraQuery]     = useState("");
  const [reraResults, setReraResults] = useState([]);
  const [reraProject, setReraProject] = useState(null);
  const [reraProjects, setReraProjects] = useState([]);
  const [reraLoaded, setReraLoaded]   = useState(false);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeSection, setActiveSection] = useState("property");
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [feedback, setFeedback]   = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);

  const isPlot      = propType.toLowerCase().includes("plot") || propType.toLowerCase().includes("land");
  const isVilla     = propType.toLowerCase().includes("villa") || propType.toLowerCase().includes("row");
  const isPenthouse = propType.toLowerCase().includes("penthouse");

  // ── Load RERA index ────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/data/rera_index.json')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if(d?.projects) { setReraProjects(d.projects); setReraLoaded(true); }})
      .catch(() => {});
  }, []);

  // ── RERA search ────────────────────────────────────────────────────────────
  const searchRERA = (q) => {
    setReraQuery(q); setReraProject(null);
    if(!q.trim() || q.length < 2) { setReraResults([]); return; }
    const tokens = q.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(' ').filter(t=>t.length>=2);
    const scored = reraProjects.map(p => {
      const toks = p.search_tokens || [];
      const disp = (p.search_display||'').toLowerCase();
      const hits = tokens.filter(t => toks.some(pt=>pt.includes(t)) || disp.includes(t)).length;
      return {...p, _score: hits};
    }).filter(p=>p._score>0).sort((a,b)=>b._score-a._score).slice(0,5);
    setReraResults(scored);
  };
  const selectRERA = (p) => {
    setReraProject(p); setReraResults([]); setReraQuery(p.project_name);
    if(p.city) setCity(p.city);
    if(p.city) setLocality(p.city + (p.district && p.district!==p.city ? ', '+p.district : ''));
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const fmtL = (n) => n >= 10000000 ? (n/10000000).toFixed(2)+"Cr" : n >= 100000 ? (n/100000).toFixed(2)+"L" : n >= 1000 ? (n/1000).toFixed(0)+"k" : String(Math.round(n||0));
  const fmt  = (n) => "₹" + fmtL(n);
  const fmtCr= (n) => `₹${(n/1e7).toFixed(2)} Cr`;

  const toggleAmenity = (id) => setSelAmenities(p => p.includes(id) ? p.filter(x=>x!==id) : [...p,id]);
  const toggleCivicGood = (id) => setCivicGood(p => p.includes(id) ? p.filter(x=>x!==id) : [...p,id]);
  const toggleCivicBad  = (id) => setCivicBad(p  => p.includes(id) ? p.filter(x=>x!==id) : [...p,id]);
  const toggleInfra = (id) => setSelInfra(p => p.includes(id) ? p.filter(x=>x!==id) : [...p,id]);

  const resetForm = () => {
    setLocality(""); setUserMinPrice(""); setUserMaxPrice(""); setResult(null);
    setError(""); setFeedback(null);
    setSelAmenities(["security_24x7","cctv","power_backup_full","lift","covered_parking","water_24x7"]);
    setApprovalType("BBMP A Khata"); setLegalStatus("Clear Title");
    setHasLakeView(false); setHasGardenView(false); setHasParkView(false);
    setHasCityView(false); setHasDuplex(false); setHasServantRoom(false); setMaintenanceCharge("");
  };

  // ── Civic score ────────────────────────────────────────────────────────────
  const civicScore = (() => {
    const base = 50;
    const good = (CIVIC_FACTORS||[]).filter(f=>f.positive&&civicGood.includes(f.id)).reduce((s,f)=>s+(f.score||0),0);
    const bad  = (CIVIC_FACTORS||[]).filter(f=>!f.positive&&civicBad.includes(f.id)).reduce((s,f)=>s+(f.score||0),0);
    return Math.min(100, Math.max(0, base + good + bad));
  })();

  const amenityScore = amenityMode === "count"
    ? Math.min(100, Math.round(amenityCount * 1.2))
    : Math.min(100, Math.round(selAmenities.length * 2.5));

  const getAmenityPremium = () => {
    if(amenityMode === "count") {
      const avg = amenityCount<=10?70:amenityCount<=25?120:amenityCount<=45?180:230;
      return amenityCount * avg * 0.4;
    }
    return Object.entries(AMENITY_CATEGORIES||{}).reduce((total,[cat,data]) =>
      total + data.items.filter(a=>selAmenities.includes(a.id)).reduce((s,a)=>s+a.premium*data.weight,0), 0);
  };

  const infraPremium = (INFRA_ITEMS||[]).filter(x=>selInfra.includes(x.id)).reduce((s,x)=>s+(x.premium||0),0);

  // ── Pricing formula (exact original) ──────────────────────────────────────
  const waterFactor = {"Borewell (Hard Water)":0.96,"Corporation Supply":1.0,"Treated / RO Water":1.04,"Mixed (Borewell + Corp)":0.98,"24×7 Treated Water":1.06}[waterQuality]||1.0;
  const floorFactor = () => {
    if(isVilla||isPlot) return 1.0;
    const pct = selectedFloor/totalFloors;
    if(selectedFloor===0) return 0.90;
    if(pct<=0.15) return 0.93;
    if(pct<=0.35) return 0.97;
    if(pct<=0.60) return 1.0;
    if(pct<=0.80) return 1.04;
    if(isPenthouse||pct>0.90) return 1.12;
    return 1.07;
  };
  const wallFactor   = {"No Common Walls (Corner/End Unit)":1.07,"1 Common Wall":1.0,"2 Common Walls (Middle Unit)":0.95,"3 Common Walls":0.90}[commonWalls]||1.0;
  const parkingPremium = carParking*150;
  const constFactor    = (CONSTRUCTION_FACTOR||{})[constructionStatus]||1.0;
  const appreciationOnCompletion = (COMPLETION_APPRECIATION||{})[constructionStatus]||0;
  const devFactor      = customDevPremium ? (1+parseFloat(customDevPremium)/100) : ((DEVELOPER_TIERS||{})[developer]||1.0);
  const ageFactor      = {"New (0-2 yrs)":1.0,"Recent (3-5 yrs)":0.93,"Mid (6-10 yrs)":0.85,"Old (11-20 yrs)":0.75,"Very Old (20+ yrs)":0.62}[age]||1.0;
  const civicPremium   = (civicScore-50)*8;
  const viewPremium    = (hasLakeView?350:0)+(hasGardenView?200:0)+(hasParkView?150:0)+(hasCityView?220:0)+(hasDuplex?600:0)+(hasServantRoom?120:0);
  const propKind       = isPlot?"plot":isVilla?"villa":isPenthouse?"penthouse":"apartment";
  const BASE_RATE      = getCityTierRate(city,propKind);
  const normCorrFactor = priceCorrections.length>0
    ? priceCorrections.slice(-3).reduce((s,c)=>s+c.factor,0)/Math.min(3,priceCorrections.length)
    : 1.0;

  const calcEstimate = () => {
    const amenPrem = getAmenityPremium();
    const rate = Math.round(
      (BASE_RATE+amenPrem+infraPremium+parkingPremium+civicPremium+viewPremium)
      *ageFactor*waterFactor*floorFactor()*wallFactor*devFactor*constFactor*normCorrFactor
    );
    const total = rate*(isPlot?plotArea:area);
    return {rate, total, low:Math.round(total*0.87), high:Math.round(total*1.14)};
  };

  // ── GST calculation (new feature) ─────────────────────────────────────────
  const calcGST = (propValue) => {
    // Under-construction: 5% GST (1% for affordable housing < 45L)
    // Ready to move: No GST
    if(constructionStatus==="Ready to Move / Possession") return {rate:0, amount:0, note:"No GST for ready-to-move properties"};
    const est = propValue||calcEstimate().total;
    const isAffordable = est <= 4500000; // 45L
    const gstRate = isAffordable ? 1 : 5;
    const gstAmount = Math.round(est*gstRate/100);
    return {
      rate:    gstRate,
      amount:  gstAmount,
      note:    isAffordable
        ? `1% GST (affordable housing <₹45L) → ₹${fmtL(gstAmount)}`
        : `5% GST (under-construction) → ₹${fmtL(gstAmount)}`,
      total:   est+gstAmount,
    };
  };

  // ── Auto-maintenance calculation ───────────────────────────────────────────
  const autoMaintCalc = () => {
    const amenCount = amenityMode==="count" ? amenityCount : selAmenities.length;
    const amenFactor = amenCount<=10?1.0:amenCount<=25?1.4:amenCount<=45?1.9:2.5;
    const scaleFactor = totalFlatsInBuilding<=50?1.15:totalFlatsInBuilding<=200?1.0:totalFlatsInBuilding<=500?0.88:0.78;
    const ageFactorM = age==="New (0-2 yrs)"?0.85:age==="Recent (3-5 yrs)"?1.0:age==="Mid (6-10 yrs)"?1.2:age==="Old (11-20 yrs)"?1.45:1.7;
    const monthly = Math.round(2.2*amenFactor*scaleFactor*ageFactorM*area);
    const tierCagr = BASE_RATE>=8000?9.5:BASE_RATE>=4500?11:BASE_RATE>=3000?13:14.5;
    const devBoost = (DEVELOPER_TIERS||{})[developer]>=1.15?1.5:0;
    const approvalPenalty = (APPROVAL_IMPACT||{})[approvalType]<0.85?-2:0;
    const cagr = Math.round((tierCagr+devBoost+approvalPenalty)*10)/10;
    const taxRate = getPropertyTaxRate ? getPropertyTaxRate(approvalState||detectStateFromCity(city)) : 0.1;
    const tax = Math.round(calcEstimate().total*taxRate/100);
    return {monthly, annual:monthly*12, cagr, tax, taxRate};
  };

  // ── Main analysis call ─────────────────────────────────────────────────────
  const analyze = async () => {
    if(!locality.trim()) { setError("Please enter locality"); return; }
    setLoading(true); setResult(null); setError(""); setShowFeedback(false);
    const est = calcEstimate();
    const gst = calcGST(est.total);
    const amenList = amenityMode==="count"
      ? amenityCount+" amenities (count-based)"
      : selAmenities.map(id=>ALL_AMENITIES.find(x=>x.id===id)?.label).filter(Boolean).join(", ");
    const infraList = selInfra.map(id=>(INFRA_ITEMS||[]).find(x=>x.id===id)?.label).filter(Boolean).join(", ");
    const goodCivic = (CIVIC_FACTORS||[]).filter(f=>f.positive&&civicGood.includes(f.id)).map(f=>f.label).join(", ");
    const badCivic  = (CIVIC_FACTORS||[]).filter(f=>!f.positive&&civicBad.includes(f.id)).map(f=>f.label).join(", ");
    const isUC = constructionStatus!=="Ready to Move / Possession";

    const prompt = `You are an expert Indian real estate valuation AI with deep knowledge of Indian cities, localities, builders, and market trends.
Today's date: ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}.

PRICING ACCURACY: market_rate_sqft MUST be realistic for this EXACT locality — not a generic city average. Override the formula estimate with your market knowledge where confident.

Property: ${propType} | Location: ${locality}, ${city}, India
Config: ${isPlot?"Plot":bhk}, ${isPlot?plotArea+" "+plotAreaUnit:area+" sqft"} (${isPlot?"land":areaType})
${!isPlot?"Floor: "+selectedFloor+" of "+totalFloors+" | Blocks: "+totalBlocks+" | Common Walls: "+commonWalls:""}
${!isPlot&&!isVilla?"Total Flats: "+totalFlatsInBuilding+" ("+( totalFlatsInBuilding<=50?"Low density":totalFlatsInBuilding<=200?"Medium":totalFlatsInBuilding<=500?"High density":"Very high density")+")":""}
Building: ${buildingType} | Developer: ${developer}${customDevPremium?" (+"+customDevPremium+"% premium)":""}
Construction: ${constructionStatus}${isUC?" | Target: "+completionYear:""}
Approval: ${approvalType} | Legal: ${legalStatus} | Quality: ${constructionQuality}
Community: ${communityType} | Ventilation: ${ventilation}
${!isPlot?"Balconies: "+noBalconies+" | Servant Room: "+(hasServantRoom?"Yes":"No")+" | Duplex: "+(hasDuplex?"Yes":"No"):""}
Views: ${[hasLakeView&&"Lake View (+5-10%)",hasGardenView&&"Garden View (+3-5%)",hasParkView&&"Park View (+2-4%)",hasCityView&&"City View (+3-6%)"].filter(Boolean).join(", ")||"No premium view"}
Parking: ${carParking} | Water: ${waterQuality} | Age: ${!isPlot?age:"NA"}
Maintenance: ${maintenanceCharge?"₹"+maintenanceCharge+" "+maintenanceType:"Auto-calculated"}
Amenities (${amenityMode==="count"?amenityCount+" count":selAmenities.length+" selected"}): ${amenList.slice(0,400)}
Infra nearby: ${infraList||"None selected"}
Civic score: ${civicScore}/100 | Good: ${goodCivic||"None"} | Issues: ${badCivic||"None"}
Formula est: ₹${est.rate.toLocaleString()}/sqft → ₹${fmtL(est.total)} (range: ₹${fmtL(est.low)}–₹${fmtL(est.high)})
GST: ${gst.note}
${userMinPrice&&userMaxPrice?"User-known range: ₹"+userMinPrice+"-"+userMaxPrice+"/sqft":""}
${priceCorrections.length>0?"User corrections: "+priceCorrections.length+", factor: "+normCorrFactor.toFixed(2):""}

Return ONLY raw JSON (no markdown, start with {, end with }):
{
  "location_name_corrected": "correct name if typo, else same",
  "market_rate_sqft": <integer>,
  "total_value": <integer>,
  "low_estimate": <integer>,
  "high_estimate": <integer>,
  "accuracy_verdict": "Undervalued or Fair Value or Overvalued or Premium",
  "verdict_reason": "1 sentence",
  "ai_vs_formula_gap_pct": <integer>,
  "locality_insight": "2 sentences about this market",
  "price_trend": "Rising or Stable or Declining",
  "trend_reason": "1 sentence",
  "yoy_appreciation_pct": <number>,
  "civic_grievances_nearby": ["real issue 1","issue 2","issue 3"],
  "civic_impact": "1 sentence",
  "water_impact": "1 sentence",
  "amenity_score_impact": "1 sentence",
  "approval_impact": "1 sentence on how ${approvalType} affects price",
  "legal_status_note": "1 sentence",
  "construction_quality_note": "1 sentence",
  "view_premium_note": ${hasLakeView||hasCityView||hasGardenView?"\"1 sentence\"":"null"},
  "maintenance_assessment": ${maintenanceCharge?"\"1 sentence\"":"null"},
  "traffic_density_note": "1 sentence on ${totalFlatsInBuilding} flats impact",
  "floor_impact": "mention floor ${selectedFloor} pricing impact",
  "developer_tier_impact": "1 sentence",
  "sunlight_assessment": "1 sentence on floor/orientation sunlight",
  "elder_friendliness": "Good or Average or Poor - reason",
  "kid_friendliness": "Good or Average or Poor - reason",
  "price_history": [{"year":2017,"price_sqft":2800},{"year":2018,"price_sqft":3100},{"year":2019,"price_sqft":3400},{"year":2020,"price_sqft":3200},{"year":2021,"price_sqft":3600},{"year":2022,"price_sqft":4100},{"year":2023,"price_sqft":4700},{"year":2024,"price_sqft":5400}],
  "upcoming_civic_projects": [{"project":"name","status":"announced or UC","expected_completion":"2026","score_impact":"+5","price_impact":"+8-12%"}],
  "comparable_projects": [{"name":"Project Name","rate_sqft":"₹7,500/sqft","distance":"0.8 km away","maps_link":"https://www.google.com/maps/search/ProjectName+${locality}+${city}"},{"name":"Another Project","rate_sqft":"₹6,800/sqft","distance":"1.2 km away","maps_link":"https://www.google.com/maps/search/AnotherProject+${locality}+${city}"}],
  "gst_applicable": ${isUC?"true":"false"},
  "gst_rate_pct": ${isUC?gst.rate:0},
  "gst_amount": ${isUC?gst.amount:0},
  "gst_note": "${gst.note}",
  "total_with_gst": ${isUC?gst.total:est.total},
  "negotiation_tip": "1 actionable sentence",
  "red_flags": ["flag 1","flag 2","flag 3"],
  "resale_potential": "High or Medium or Low",
  "rental_yield_pct": <number>,
  "best_for": "End User or Investor or Both",
  "completion_price_estimate": ${isUC?"<integer>":"null"},
  "completion_appreciation_pct": ${isUC?"<number>":"null"},
  "investment_recommendation": "${isUC?"1 sentence investor advice":"null"}"
}`;

    const cacheKey = "pricer_"+ [locality,city,propType,isPlot?plotArea:area,bhk,selectedFloor,totalFloors,developer,constructionStatus,approvalType,legalStatus,amenityMode==="count"?amenityCount:selAmenities.slice().sort().join(","),carParking,waterQuality,hasLakeView,hasCityView,hasDuplex].join("_").toLowerCase().replace(/[^a-z0-9_]+/g,"_");

    try {
      const res = await fetch(API_ENDPOINT, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({model:"claude-sonnet-4-6", max_tokens:8000, temperature:0,
          messages:[{role:"user",content:prompt}], cacheKey, cacheType:"pricer"}),
      });
      const d = await res.json();
      if(d.error) { setError("API: "+d.error.message); setLoading(false); return; }
      const text = d.content?.map(b=>b.text||"").join("")||"";
      const parsed = parseJSON(text);
      if(parsed) {
        setResult({...parsed, our_estimate:est, isUC, constructionStatus, gst});
        setShowFeedback(true);
      } else {
        // Formula fallback
        setResult({
          market_rate_sqft:est.rate, total_value:est.total,
          low_estimate:est.low, high_estimate:est.high,
          accuracy_verdict:"Fair Value", verdict_reason:"Formula-based estimate",
          ai_vs_formula_gap_pct:0, locality_insight:"AI analysis unavailable. Formula estimate shown.",
          price_trend:"Stable", yoy_appreciation_pct:8,
          comparable_projects:[], red_flags:[],
          resale_potential:"Medium", rental_yield_pct:3.5, best_for:"End User",
          gst_applicable:isUC, gst_rate_pct:gst.rate, gst_amount:gst.amount,
          gst_note:gst.note, total_with_gst:isUC?gst.total:est.total,
          our_estimate:est, isUC, constructionStatus, gst,
        });
        setError("Parse failed — formula estimate shown. Raw: "+text.slice(0,200));
      }
    } catch(e) { setError("Error: "+e.message); }
    setLoading(false);
  };

  const submitCorrection = () => {
    const min = parseFloat(userMinPrice), max = parseFloat(userMaxPrice);
    if(!min||!max||!result) return;
    const factor = ((min+max)/2) / result.market_rate_sqft;
    setPriceCorrections(p=>[...p,{city,locality,propType,factor,userMin:min,userMax:max,aiRate:result.market_rate_sqft}]);
    setFeedback({type:"learned",msg:`Saved! AI rate ₹${result.market_rate_sqft}/sqft → Your range ₹${min}-₹${max}. Factor: ${((factor-1)*100).toFixed(1)}%.`});
    setShowFeedback(false);
  };

  const verdictColor = (v) => !v?C.muted:v==="Undervalued"?C.green:v==="Fair Value"?C.blue:v==="Overvalued"?C.red:C.amber;
  const sectionBtn = (id,label) => (
    <button key={id} onClick={()=>setActiveSection(id)}
      style={{padding:"7px 14px",fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,
        background:activeSection===id?C.blue:"#F1F5F9",color:activeSection===id?"#fff":C.muted,
        border:"none",borderRadius:20,cursor:"pointer"}}>{label}</button>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // OPTION B RENDER — 2×3 property grid + collapsible grouped cards
  // ═══════════════════════════════════════════════════════════════════════════

  // Collapsible group state
  const [openGroups, setOpenGroups] = React.useState({
    location:true, unit:true, building:true, legal:true,
    quality:true, views:true, maintenance:true
  });
  const toggleGroup = (k) => setOpenGroups(p => ({...p, [k]: !p[k]}));

  const G = ({id, icon, title, badge, children}) => {
    const open = openGroups[id];
    const hasBadge = badge != null;
    return (
      <div style={{background:"#fff",border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:6}}>
        <div onClick={()=>toggleGroup(id)}
          style={{padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",
            cursor:"pointer",background:open?"#fff":"#FAFBFC"}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:13}}>{icon}</span>
            <span style={{fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:700,color:C.dark}}>{title}</span>
            {hasBadge && <span style={{fontSize:9,background:"#EFF6FF",color:C.blue,
              padding:"1px 7px",borderRadius:8,fontWeight:600}}>{badge}</span>}
          </div>
          <span style={{color:C.muted,fontSize:12,transform:open?"rotate(0)":"rotate(180deg)",
            transition:"transform .2s"}}>{open?"▲":"▼"}</span>
        </div>
        {open && <div style={{padding:"10px 12px",display:"flex",flexDirection:"column",gap:8,
          borderTop:`1px solid ${C.border}`}}>{children}</div>}
      </div>
    );
  };

  const PROP_TYPES_FULL = [
    {type:"Apartment / Flat",      icon:"🏢", sub:"Flats & units"},
    {type:"Villa / Independent House", icon:"🏡", sub:"Independent homes"},
    {type:"Plot / Land",           icon:"🏗️", sub:"Bare land"},
    {type:"Penthouse",             icon:"🏙️", sub:"Top floor luxury"},
    {type:"Row House / Townhouse", icon:"🏘️", sub:"Townhouse / linked"},
    {type:"Commercial",            icon:"🏪", sub:"Shops & offices"},
  ];

  const SECTION_CONFIG = [
    {id:"property",  label:"Property",  icon:"🏠"},
    {id:"amenities", label:"Amenities", icon:"✨"},
    {id:"civic",     label:"Civic",     icon:"🏛️"},
    {id:"pricing",   label:"Pricing",   icon:"💰"},
    {id:"uds",       label:"UDS & Loan",icon:"📜"},
  ];
  const sectionIdx = SECTION_CONFIG.findIndex(s=>s.id===activeSection);

  // Live estimate bar (always visible in full valuation mode)
  const LiveEstimate = () => {
    if(!locality.trim() && !city) return null;
    const est = calcEstimate();
    const gst = calcGST(est.total);
    if(isNaN(est.rate) || est.rate <= 0) return null;
    return (
      <div style={{background:"linear-gradient(135deg,#0F1B2D,#1E3A5F)",borderRadius:10,
        padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",
        position:"sticky",bottom:0,zIndex:10}}>
        <div>
          <div style={{color:"#94A3B8",fontSize:9,fontFamily:"Inter,sans-serif",
            textTransform:"uppercase",letterSpacing:.5,marginBottom:2}}>Live estimate</div>
          <div style={{color:"#F8FAFB",fontFamily:"serif",fontSize:16}}>
            {fmt(est.low)} – {fmtCr(est.high)}
          </div>
          {gst.amount>0 && <div style={{color:"#FCD34D",fontSize:10,fontFamily:"Inter,sans-serif",marginTop:1}}>
            + GST {gst.rate}% → {fmt(gst.total)}
          </div>}
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{color:"#34D399",fontSize:14,fontWeight:700,fontFamily:"Inter,sans-serif"}}>
            ₹{est.rate?.toLocaleString()}/sqft
          </div>
          <div style={{color:"#94A3B8",fontSize:9,fontFamily:"Inter,sans-serif",marginTop:1}}>
            Updates as you fill
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>

      {/* ── Mode toggle ── */}
      <div style={{display:"flex",background:"#E2E8F0",borderRadius:11,padding:3,gap:3}}>
        {[["quick","⚡ Quick Check"],["full","🔬 Full Valuation"]].map(([m,label])=>(
          <button key={m} onClick={()=>{setMode(m);setResult(null);setError("");}}
            style={{flex:1,padding:"9px 6px",borderRadius:9,border:"none",cursor:"pointer",
              fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:700,
              background:mode===m?"#fff":"transparent",color:mode===m?"#1E293B":"#64748B",
              boxShadow:mode===m?"0 1px 5px rgba(0,0,0,.12)":"none"}}>
            {label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          QUICK CHECK MODE
      ══════════════════════════════════════════════════════════════════ */}
      {mode==="quick" && (<>

        {/* RERA search hero */}
        <div style={{background:"linear-gradient(160deg,#0F1B2D,#1E3A5F)",borderRadius:14,padding:15}}>
          <div style={{color:"#F8FAFB",fontFamily:"serif",fontSize:15,marginBottom:3}}>Search by project or builder</div>
          <div style={{color:"#94A3B8",fontFamily:"Inter,sans-serif",fontSize:11,marginBottom:11,lineHeight:1.4}}>
            {reraLoaded?"RERA status pulled automatically — no reg number needed":"Enter locality or project name to price"}
          </div>
          <div style={{display:"flex",gap:6,position:"relative"}}>
            <input value={reraQuery} onChange={e=>searchRERA(e.target.value)}
              placeholder="Prestige, Godrej, Brigade Utopia…"
              style={{flex:1,background:"#fff",border:"none",borderRadius:9,padding:"10px 12px",
                fontSize:13,fontFamily:"Inter,sans-serif",color:"#1E293B",outline:"none"}}/>
            {reraQuery&&<button onClick={()=>{setReraQuery("");setReraResults([]);setReraProject(null);}}
              style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",
                background:"none",border:"none",color:"#94A3B8",cursor:"pointer",fontSize:16}}>×</button>}
          </div>
          {reraResults.length>0&&(
            <div style={{background:"#fff",borderRadius:9,marginTop:6,overflow:"hidden",
              boxShadow:"0 4px 16px rgba(0,0,0,.2)"}}>
              {reraResults.map((p,i)=>(
                <div key={i} onClick={()=>selectRERA(p)}
                  style={{padding:"10px 13px",borderBottom:i<reraResults.length-1?"1px solid #F1F5F9":"none",cursor:"pointer"}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:"#1E293B"}}>{p.project_name}</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#64748B"}}>{p.company_name} · {p.city}</div>
                </div>
              ))}
            </div>
          )}
          {!reraLoaded&&(
            <div style={{display:"flex",gap:5,marginTop:8,flexWrap:"wrap"}}>
              {["Prestige","Godrej","Brigade","Sobha","Lodha"].map(s=>(
                <span key={s} onClick={()=>searchRERA(s)}
                  style={{background:"rgba(255,255,255,0.12)",color:"#CBD5E1",fontSize:10,
                    padding:"3px 9px",borderRadius:12,cursor:"pointer",
                    border:"1px solid rgba(255,255,255,0.15)"}}>
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* RERA card */}
        {reraProject&&(
          <div style={{background:"#fff",border:"1.5px solid #2563EB",borderRadius:12,padding:13}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
              <div style={{fontFamily:"serif",fontSize:14,color:"#1E293B",flex:1,paddingRight:8}}>{reraProject.project_name}</div>
              <span style={{flexShrink:0,fontSize:10,fontWeight:700,padding:"3px 9px",borderRadius:10,
                background:reraProject.status==="Completed"?"#F0FDF4":"#EFF6FF",
                color:reraProject.status==="Completed"?"#15803D":"#1D4ED8"}}>● {reraProject.status}</span>
            </div>
            <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#64748B",marginBottom:7}}>
              {reraProject.company_name} · {reraProject.city}
            </div>
            {reraProject.rera_id&&reraProject.rera_id!=="—"&&(
              <div style={{fontFamily:"monospace",fontSize:9.5,color:"#94A3B8",background:"#F8FAFB",
                padding:"3px 8px",borderRadius:5,marginBottom:8}}>{reraProject.rera_id}</div>
            )}
            <a href={reraProject.direct_url} target="_blank" rel="noopener noreferrer"
              style={{fontSize:11,color:"#2563EB",fontWeight:600,textDecoration:"none"}}>
              View on {reraProject.state} RERA →
            </a>
          </div>
        )}

        {/* 4 quick inputs */}
        <div style={{background:"#fff",border:`1px solid ${C.border}`,borderRadius:12,padding:13,
          display:"flex",flexDirection:"column",gap:10}}>
          {!reraProject&&(
            <div>
              <div style={LS}>Locality / Project</div>
              <input value={locality} onChange={e=>setLocality(e.target.value)}
                placeholder="e.g. Whitefield, Bengaluru" style={{...IS,width:"100%"}}/>
            </div>
          )}
          <div style={{display:"flex",gap:8}}>
            <div style={{flex:1}}><div style={LS}>Type</div>
              <select value={propType} onChange={e=>setPropType(e.target.value)} style={IS}>
                {(PROPERTY_TYPES||["Apartment / Flat","Villa / Independent House","Plot / Land","Penthouse","Row House / Townhouse"]).map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={{flex:1}}><div style={LS}>Area (sqft)</div>
              <input type="number" value={area}
                onChange={e=>setArea(e.target.value===''?'':parseInt(e.target.value)||'')}
                onBlur={e=>{const v=parseInt(e.target.value);setArea(v>0?v:1200);}} style={IS}/>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <div style={{flex:1}}><div style={LS}>City</div>
              <input value={city} onChange={e=>setCity(e.target.value)} style={IS}/>
            </div>
            <div style={{flex:1}}><div style={LS}>Asking price ₹</div>
              <input value={askingPrice} onChange={e=>setAskingPrice(e.target.value)} placeholder="Optional" style={IS}/>
            </div>
          </div>
        </div>

        {/* Quick result */}
        {(locality.trim()||reraProject||area!==1200)&&(()=>{
          const est=calcEstimate(); const gst=calcGST(est.total);
          if(isNaN(est.rate)||est.rate<=0) return null;
          return (
            <div style={{background:"linear-gradient(135deg,#0F1B2D,#1E293B)",borderRadius:13,padding:15}}>
              <div style={{color:"#94A3B8",fontFamily:"Inter,sans-serif",fontSize:11,marginBottom:3}}>
                Fair market estimate · {city}
              </div>
              <div style={{color:"#F8FAFB",fontFamily:"serif",fontSize:26,marginBottom:3}}>
                {fmt(est.low)} – {fmtCr(est.high)}
              </div>
              <div style={{color:"#94A3B8",fontFamily:"Inter,sans-serif",fontSize:11,marginBottom:gst.amount?6:10}}>
                ₹{est.rate.toLocaleString()}/sqft · formula-based
              </div>
              {gst.amount>0&&(
                <div style={{color:"#FCD34D",fontFamily:"Inter,sans-serif",fontSize:11,marginBottom:10}}>
                  + GST ({gst.rate}%) = {fmt(gst.total)} total
                </div>
              )}
              {askingPrice&&(()=>{
                const asking=parseFloat(askingPrice.replace(/[₹,CcRr]/gi,'').trim())
                  *(askingPrice.toLowerCase().includes('l')?1e5:askingPrice.toLowerCase().includes('c')?1e7:1);
                if(!asking) return null;
                const diff=((asking-est.total)/est.total*100).toFixed(1);
                const fair=Math.abs(parseFloat(diff))<10, over=parseFloat(diff)>10;
                return <div style={{background:"rgba(255,255,255,.08)",borderRadius:8,padding:"9px 11px",
                  fontFamily:"Inter,sans-serif",fontSize:11,color:"#F8FAFB",marginBottom:10}}>
                  {fair?"✅ Asking price is within fair range":over?`⚠️ ${diff}% above estimate`:`💡 ${Math.abs(diff)}% below — good value`}
                </div>;
              })()}
              <div style={{display:"flex",gap:7}}>
                <button onClick={()=>{setMode("full");setResult(null);}}
                  style={{flex:1,padding:9,borderRadius:8,fontSize:11,fontWeight:700,fontFamily:"Inter,sans-serif",
                    cursor:"pointer",background:"#2563EB",color:"#fff",border:"none"}}>
                  Full breakdown →
                </button>
                <button onClick={()=>{setMode("full");setActiveSection("uds");setResult(null);}}
                  style={{flex:1,padding:9,borderRadius:8,fontSize:11,fontWeight:700,fontFamily:"Inter,sans-serif",
                    cursor:"pointer",background:"rgba(255,255,255,.1)",color:"#F8FAFB",border:"none"}}>
                  UDS & Loan →
                </button>
              </div>
            </div>
          );
        })()}

      </>)}

      {/* ══════════════════════════════════════════════════════════════════
          FULL VALUATION — OPTION B DESIGN
      ══════════════════════════════════════════════════════════════════ */}
      {mode==="full"&&(
        <div style={{background:"#fff",borderRadius:12,border:`1px solid ${C.border}`,padding:14}}>

          {/* Header */}
          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark,marginBottom:10,
            display:"flex",alignItems:"center",gap:6}}>
            🏘️ Property Price Analyser
          </div>

          {/* ── 2×3 Property type grid (Option B design) ── */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:12}}>
            {PROP_TYPES_FULL.map(({type,icon,sub})=>{
              const sel = propType===type;
              return (
                <button key={type} onClick={()=>{setPropType(type);resetForm();}}
                  style={{background:sel?"#EFF6FF":"#F8FAFB",
                    border:`1.5px solid ${sel?C.blue:C.border}`,
                    borderRadius:10,padding:"10px 10px",cursor:"pointer",
                    textAlign:"left",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:20,flexShrink:0}}>{icon}</span>
                  <div>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:700,
                      color:sel?"#1D4ED8":C.dark,lineHeight:1.2}}>{type}</div>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,marginTop:1}}>{sub}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Section tabs (scrollable) ── */}
          <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:2,marginBottom:10}}>
            {SECTION_CONFIG.map((s,i)=>{
              const sel = activeSection===s.id;
              return (
                <button key={s.id} onClick={()=>setActiveSection(s.id)}
                  style={{flexShrink:0,padding:"7px 12px",borderRadius:16,border:"none",cursor:"pointer",
                    fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:700,
                    background:sel?C.blue:"#F1F5F9",color:sel?"#fff":C.muted}}>
                  {s.icon} {s.label}
                </button>
              );
            })}
          </div>

          {/* ── Section progress bar ── */}
          <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:12}}>
            {SECTION_CONFIG.map((s,i)=>(
              <div key={s.id} style={{flex:1,height:3,borderRadius:2,
                background:i<sectionIdx?C.blue:i===sectionIdx?"#0F1B2D":C.border}}/>
            ))}
            <span style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,
              whiteSpace:"nowrap",marginLeft:5,fontWeight:600}}>
              {sectionIdx+1}/5
            </span>
          </div>

          {/* ════════════════════════════════════════
              SECTION: PROPERTY — collapsible groups
          ════════════════════════════════════════ */}
          {activeSection==="property"&&(
            <div style={{display:"flex",flexDirection:"column",gap:0}}>

              {/* Group 1: Location */}
              <G id="location" icon="📍" title="Location" badge={locality?"filled":null}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>City</label>
                    <input value={city} onChange={e=>setCity(e.target.value)} style={IS} placeholder="Bengaluru"/>
                  </div>
                  <div><label style={LS}>Locality / Area *</label>
                    <input value={locality} onChange={e=>setLocality(e.target.value)} style={IS} placeholder="e.g. Whitefield"/>
                  </div>
                </div>
              </G>

              {/* Group 2: Unit Details */}
              {!isPlot&&(
                <G id="unit" icon="🏠" title="Unit Details">
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><label style={LS}>BHK / Config</label>
                      <select value={bhk} onChange={e=>setBhk(e.target.value)} style={IS}>
                        {(BHK_OPTIONS||["Studio","1 BHK","2 BHK","3 BHK","4 BHK","5+ BHK"]).map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                    <div><label style={LS}>Area Type</label>
                      <select value={areaType} onChange={e=>setAreaType(e.target.value)} style={IS}>
                        {(AREA_TYPES||["Carpet Area","Built-Up Area","Super Built-Up Area"]).map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label style={LS}>Area (sqft) — <strong style={{color:C.dark}}>{(+area||0).toLocaleString()}</strong></label>
                    <input type="range" min={300} max={8000} step={50} value={area||1200} onChange={e=>setArea(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                    <div style={{display:"flex",justifyContent:"space-between",fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,marginTop:2}}>
                      <span>300</span><span>8,000</span>
                    </div>
                  </div>
                </G>
              )}

              {isPlot&&(
                <G id="unit" icon="🏗️" title="Plot Details">
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div>
                      <label style={LS}>Plot Area — <strong style={{color:C.dark}}>{(+plotArea||0).toLocaleString()}</strong></label>
                      <input type="range" min={100} max={20000} step={100} value={plotArea||1200} onChange={e=>setPlotArea(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                    </div>
                    <div><label style={LS}>Unit</label>
                      <select value={plotAreaUnit} onChange={e=>setPlotAreaUnit(e.target.value)} style={IS}>
                        {["sqft","sqyd","guntha","acre","cents"].map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                  </div>
                </G>
              )}

              {/* Group 3: Building */}
              {!isPlot&&(
                <G id="building" icon="🏗️" title="Building">
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><label style={LS}>Building Type</label>
                      <select value={buildingType} onChange={e=>setBuildingType(e.target.value)} style={IS}>
                        {(BUILDING_TYPES||["High Rise (>10 floors)","Mid Rise (5-10 floors)","Low Rise (<5 floors)"]).map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                    <div><label style={LS}>Common Walls</label>
                      <select value={commonWalls} onChange={e=>setCommonWalls(e.target.value)} style={IS}>
                        {(COMMON_WALLS||["No Common Walls (Corner/End Unit)","1 Common Wall","2 Common Walls (Middle Unit)","3 Common Walls"]).map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                  </div>
                  {!isVilla&&(
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      <div>
                        <label style={LS}>Total Floors — <strong style={{color:C.dark}}>{totalFloors}</strong></label>
                        <input type="range" min={1} max={60} value={totalFloors}
                          onChange={e=>{setTotalFloors(+e.target.value);if(selectedFloor>+e.target.value)setSelectedFloor(+e.target.value);}}
                          style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                      </div>
                      <div>
                        <label style={LS}>Your Floor — <strong style={{color:C.dark}}>{selectedFloor===0?"G":selectedFloor}</strong></label>
                        <input type="range" min={0} max={totalFloors} value={selectedFloor}
                          onChange={e=>setSelectedFloor(+e.target.value)}
                          style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                      </div>
                    </div>
                  )}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div>
                      <label style={LS}>Blocks — <strong style={{color:C.dark}}>{totalBlocks}</strong></label>
                      <input type="range" min={1} max={30} value={totalBlocks} onChange={e=>setTotalBlocks(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                    </div>
                    <div>
                      <label style={LS}>Car Parking — <strong style={{color:C.dark}}>{carParking}</strong></label>
                      <input type="range" min={0} max={4} value={carParking} onChange={e=>setCarParking(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                    </div>
                  </div>
                  {!isVilla&&(
                    <div>
                      <label style={LS}>Total Flats — <strong style={{color:C.dark}}>{totalFlatsInBuilding}</strong></label>
                      <input type="range" min={4} max={2000} step={4} value={totalFlatsInBuilding} onChange={e=>setTotalFlatsInBuilding(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                      <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,marginTop:2}}>
                        {totalFlatsInBuilding<=50?"Low density":totalFlatsInBuilding<=200?"Medium density":totalFlatsInBuilding<=500?"High density":"Very high density"}
                      </div>
                    </div>
                  )}
                </G>
              )}

              {/* Group 4: Developer & Construction */}
              <G id="developer" icon="👷" title="Developer & Construction">
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>Developer</label>
                    <select value={developer} onChange={e=>setDeveloper(e.target.value)} style={IS}>
                      {Object.keys(DEVELOPER_TIERS||{}).map(k=><option key={k}>{k}</option>)}
                    </select>
                  </div>
                  <div><label style={LS}>Custom Premium (%)</label>
                    <input value={customDevPremium} onChange={e=>setCustomDevPremium(e.target.value)} style={IS} placeholder="e.g. 25"/>
                  </div>
                  {!isPlot&&(
                    <div><label style={LS}>Construction Status</label>
                      <select value={constructionStatus} onChange={e=>setConstructionStatus(e.target.value)} style={IS}>
                        {(CONSTRUCTION_STATUS||["Ready to Move / Possession","Under Construction (Near Completion)","Under Construction (Early Stage)","Pre-Launch / Booking Open"]).map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                  )}
                  {constructionStatus!=="Ready to Move / Possession"&&(
                    <div><label style={LS}>Target Completion</label>
                      <select value={completionYear} onChange={e=>setCompletionYear(+e.target.value)} style={IS}>
                        {[2025,2026,2027,2028,2029,2030].map(y=><option key={y}>{y}</option>)}
                      </select>
                    </div>
                  )}
                  {!isPlot&&(
                    <div><label style={LS}>Water Supply</label>
                      <select value={waterQuality} onChange={e=>setWaterQuality(e.target.value)} style={IS}>
                        {(WATER_QUALITY||["Corporation Supply","24×7 Treated Water","Treated / RO Water","Mixed (Borewell + Corp)","Borewell (Hard Water)"]).map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                  )}
                  {!isPlot&&(
                    <div><label style={LS}>Building Age</label>
                      <select value={age} onChange={e=>setAge(e.target.value)} style={IS}>
                        {["New (0-2 yrs)","Recent (3-5 yrs)","Mid (6-10 yrs)","Old (11-20 yrs)","Very Old (20+ yrs)"].map(k=><option key={k}>{k}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              </G>

              {/* Group 5: Legal, Quality, Community */}
              <G id="legal" icon="⚖️" title="Legal & Approval">
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>State</label>
                    <select value={approvalState||detectStateFromCity(city)} onChange={e=>setApprovalState(e.target.value)} style={IS}>
                      {Object.keys(APPROVAL_TYPES||{"Karnataka":[],"Maharashtra":[],"Other / Generic":[]}).map(k=><option key={k}>{k}</option>)}
                    </select>
                  </div>
                  <div><label style={LS}>Approval / Khata</label>
                    <select value={approvalType} onChange={e=>setApprovalType(e.target.value)} style={IS}>
                      {((APPROVAL_TYPES||{})[approvalState||detectStateFromCity(city)]||(APPROVAL_TYPES||{})["Other / Generic"]||["RERA Registered"]).map(k=><option key={k}>{k}</option>)}
                    </select>
                  </div>
                  <div><label style={LS}>Legal Status</label>
                    <select value={legalStatus} onChange={e=>setLegalStatus(e.target.value)} style={IS}>
                      {(LEGAL_STATUSES||["Clear Title","Title with Minor Encumbrance","Title Under Dispute","Leasehold"]).map(k=><option key={k}>{k}</option>)}
                    </select>
                  </div>
                  <div><label style={LS}>Community Type</label>
                    <select value={communityType} onChange={e=>setCommunityType(e.target.value)} style={IS}>
                      {(COMMUNITY_TYPES||["Gated Community","Housing Society","Standalone Building","Township"]).map(k=><option key={k}>{k}</option>)}
                    </select>
                  </div>
                </div>
              </G>

              {/* Group 6: Quality */}
              <G id="quality" icon="🏆" title="Construction Quality">
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>Build Quality</label>
                    <select value={constructionQuality} onChange={e=>setConstructionQuality(e.target.value)} style={IS}>
                      {(CONSTRUCTION_QUALITIES||["Premium (German/Italian fittings)","Standard (RCC, ISI materials)","Economy (Basic materials)","Luxury (Custom grade)"]).map(k=><option key={k}>{k}</option>)}
                    </select>
                  </div>
                  <div><label style={LS}>Ventilation</label>
                    <select value={ventilation} onChange={e=>setVentilation(e.target.value)} style={IS}>
                      {(VENTILATION_OPTIONS||["Good (Cross ventilation)","Average (Single side)","Poor (Enclosed)"]).map(k=><option key={k}>{k}</option>)}
                    </select>
                  </div>
                  {!isPlot&&(
                    <div>
                      <label style={LS}>Balconies — <strong style={{color:C.dark}}>{noBalconies}</strong></label>
                      <input type="range" min={0} max={4} value={noBalconies} onChange={e=>setNoBalconies(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                    </div>
                  )}
                </div>
              </G>

              {/* Group 7: Views & Special */}
              <G id="views" icon="🌅" title="Views & Special Features">
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {[
                    {l:"🏞️ Lake View",     s:hasLakeView,    f:setHasLakeView,   p:"+5-8%"},
                    {l:"🌳 Garden View",   s:hasGardenView,  f:setHasGardenView, p:"+3-5%"},
                    {l:"🌿 Park View",     s:hasParkView,    f:setHasParkView,   p:"+2-4%"},
                    {l:"🌆 City View",     s:hasCityView,    f:setHasCityView,   p:"+3-6%"},
                    {l:"🏠 Duplex",        s:hasDuplex,      f:setHasDuplex,     p:"+8-12%"},
                    {l:"🛏️ Servant Room", s:hasServantRoom, f:setHasServantRoom,p:"+2-4%"},
                  ].map(({l,s,f,p})=>(
                    <button key={l} onClick={()=>f(!s)}
                      style={{background:s?C.blue+"18":"#F8FAFB",border:`1px solid ${s?C.blue:C.border}`,
                        color:s?C.blue:C.muted,borderRadius:16,padding:"5px 10px",
                        fontFamily:"Inter,sans-serif",fontSize:10,cursor:"pointer",fontWeight:s?700:400,
                        display:"flex",alignItems:"center",gap:4}}>
                      {s&&"✓ "}{l}
                      <span style={{fontSize:9,color:s?C.blue:"#94A3B8"}}>{p}</span>
                    </button>
                  ))}
                </div>
              </G>

              {/* Group 8: Maintenance */}
              {!isPlot&&(
                <G id="maintenance" icon="🔧" title="Maintenance & Costs">
                  <button onClick={()=>setAutoCalc(!autoCalc)}
                    style={{padding:"7px 10px",fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:11,
                      background:autoCalc?C.blue:"#F1F5F9",color:autoCalc?"#fff":C.muted,
                      border:"none",borderRadius:7,cursor:"pointer",textAlign:"left",width:"100%"}}>
                    {autoCalc?"✓ Auto-calculate maintenance":"Manual entry"}
                  </button>
                  {autoCalc?(()=>{
                    const m=autoMaintCalc();
                    return(
                      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                        {[["Monthly",`₹${m.monthly.toLocaleString()}`,C.dark],
                          ["Growth",m.cagr+"%/yr",C.green],
                          ["Tax/yr","₹"+fmtL(m.tax),C.dark]].map(([l,v,col])=>(
                          <div key={l} style={{background:"#F8FAFB",borderRadius:7,padding:"8px",textAlign:"center",border:`1px solid ${C.border}`}}>
                            <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted}}>{l}</div>
                            <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:col}}>{v}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })():(
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      <div><label style={LS}>Monthly Maintenance</label>
                        <input value={maintenanceCharge} onChange={e=>setMaintenanceCharge(e.target.value)} type="number" style={IS} placeholder="₹3,500"/>
                      </div>
                      <div><label style={LS}>Type</label>
                        <select value={maintenanceType} onChange={e=>setMaintenanceType(e.target.value)} style={IS}>
                          {["flat monthly charge","per sqft/month","quarterly","annual"].map(k=><option key={k}>{k}</option>)}
                        </select>
                      </div>
                    </div>
                  )}
                </G>
              )}

              <LiveEstimate/>
            </div>
          )}

          {/* ════════════════════════════════════════
              SECTION: AMENITIES
          ════════════════════════════════════════ */}
          {activeSection==="amenities"&&!isPlot&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{display:"flex",gap:8,marginBottom:4}}>
                {[["select","Select Individually"],["count","Just Enter Count"]].map(([m,l])=>(
                  <button key={m} onClick={()=>setAmenityMode(m)}
                    style={{flex:1,padding:"8px",fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,
                      background:amenityMode===m?C.blue:"#F1F5F9",color:amenityMode===m?"#fff":C.muted,
                      border:"none",borderRadius:8,cursor:"pointer"}}>
                    {l}
                  </button>
                ))}
              </div>
              {amenityMode==="count"?(
                <div>
                  <label style={LS}>Total Amenities: <strong style={{color:C.dark}}>{amenityCount}</strong></label>
                  <input type="range" min={0} max={100} value={amenityCount} onChange={e=>setAmenityCount(+e.target.value)} style={{width:"100%",marginTop:6,accentColor:C.blue}}/>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,marginTop:6}}>
                    Score: {amenityScore}/100 · Premium: ~₹{Math.round(getAmenityPremium()).toLocaleString()}/sqft
                  </div>
                </div>
              ):(
                <>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.muted}}>
                      {selAmenities.length} selected · Score: <strong style={{color:scoreColor(amenityScore)}}>{amenityScore}/100</strong>
                    </div>
                    <button onClick={()=>setSelAmenities([])} style={{background:"none",border:"none",color:C.red,fontFamily:"Inter,sans-serif",fontSize:11,cursor:"pointer"}}>Clear</button>
                  </div>
                  {Object.entries(AMENITY_CATEGORIES||{}).map(([cat,data])=>(
                    <div key={cat} style={{borderRadius:8,border:`1px solid ${C.border}`,overflow:"hidden"}}>
                      <div onClick={()=>setExpandedCat(expandedCat===cat?null:cat)}
                        style={{padding:"10px 12px",background:C.bg,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark}}>{cat}</div>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted}}>
                            {data.items.filter(a=>selAmenities.includes(a.id)).length}/{data.items.length}
                            {data.items.filter(a=>selAmenities.includes(a.id)).length>0&&
                              ` · +₹${Math.round(data.items.filter(a=>selAmenities.includes(a.id)).reduce((s,a)=>s+a.premium*data.weight,0)*area/1e5*10)/10}L`}
                          </span>
                          <span style={{color:C.muted,fontSize:13}}>{expandedCat===cat?"▲":"▼"}</span>
                        </div>
                      </div>
                      {expandedCat===cat&&(
                        <div style={{padding:"10px 12px",display:"flex",flexDirection:"column",gap:5}}>
                          {data.items.map(a=>{
                            const on=selAmenities.includes(a.id);
                            const perSqft=Math.round(a.premium*data.weight);
                            const rupees=perSqft*(+area||1200);
                            return(
                              <div key={a.id} onClick={()=>toggleAmenity(a.id)}
                                style={{display:"flex",alignItems:"center",gap:8,padding:"7px 9px",borderRadius:8,cursor:"pointer",
                                  border:`1.5px solid ${on?"#2563EB":C.border}`,background:on?"#EFF6FF":"#fff"}}>
                                <div style={{width:18,height:18,borderRadius:5,flexShrink:0,
                                  border:`1.5px solid ${on?"#2563EB":C.border}`,background:on?"#2563EB":"#fff",
                                  display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:10}}>{on?"✓":""}</div>
                                <div style={{flex:1,fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:600,color:on?"#1D4ED8":C.dark}}>
                                  {a.essential&&"⭐ "}{a.label}
                                </div>
                                <div style={{flexShrink:0,textAlign:"right"}}>
                                  <div style={{fontFamily:"Inter,sans-serif",fontSize:9,fontWeight:700,color:on?"#2563EB":"#94A3B8"}}>₹{perSqft}/sqft</div>
                                  <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:on?"#15803D":"#94A3B8"}}>{on?"+"+fmt(rupees):"if selected"}</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
              <LiveEstimate/>
            </div>
          )}

          {/* ════════════════════════════════════════
              SECTION: CIVIC & INFRA
          ════════════════════════════════════════ */}
          {activeSection==="civic"&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{borderRadius:8,border:`1px solid ${C.border}`,overflow:"hidden"}}>
                <div style={{padding:"10px 12px",background:C.bg,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark}}>🏛️ Civic Conditions</div>
                  <div style={{background:scoreColor(civicScore),color:"#fff",borderRadius:6,padding:"2px 10px",
                    fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12}}>Score {civicScore}/100</div>
                </div>
                <div style={{padding:"10px 12px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.green,fontWeight:600,marginBottom:6}}>✅ Positives</div>
                    {(CIVIC_FACTORS||[]).filter(f=>f.positive).map(f=>{
                      const on=civicGood.includes(f.id);
                      return <button key={f.id} onClick={()=>toggleCivicGood(f.id)}
                        style={{display:"block",width:"100%",textAlign:"left",marginBottom:4,
                          background:on?"#F0FDF4":"#F8FAFB",border:`1px solid ${on?C.green:C.border}`,
                          borderRadius:6,padding:"5px 8px",fontFamily:"Inter,sans-serif",fontSize:10,
                          color:on?C.green:C.muted,cursor:"pointer",fontWeight:on?600:400}}>
                        {on?"✓ ":""}{f.label}
                      </button>;
                    })}
                  </div>
                  <div>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.red,fontWeight:600,marginBottom:6}}>⚠️ Issues</div>
                    {(CIVIC_FACTORS||[]).filter(f=>!f.positive).map(f=>{
                      const on=civicBad.includes(f.id);
                      return <button key={f.id} onClick={()=>toggleCivicBad(f.id)}
                        style={{display:"block",width:"100%",textAlign:"left",marginBottom:4,
                          background:on?"#FFF5F5":"#F8FAFB",border:`1px solid ${on?C.red:C.border}`,
                          borderRadius:6,padding:"5px 8px",fontFamily:"Inter,sans-serif",fontSize:10,
                          color:on?C.red:C.muted,cursor:"pointer",fontWeight:on?600:400}}>
                        {on?"✓ ":""}{f.label}
                      </button>;
                    })}
                  </div>
                </div>
              </div>
              <div style={{borderRadius:8,border:`1px solid ${C.border}`,padding:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark}}>🏙️ Nearby Facilities</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.blue}}>+₹{infraPremium.toLocaleString()}/sqft</div>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {(INFRA_ITEMS||[]).map(item=>{
                    const on=selInfra.includes(item.id);
                    return <button key={item.id} onClick={()=>toggleInfra(item.id)}
                      style={{background:on?C.lightBlue:"#F8FAFB",border:`1px solid ${on?C.blue:C.border}`,
                        color:on?C.blue:C.muted,borderRadius:14,padding:"4px 9px",
                        fontFamily:"Inter,sans-serif",fontSize:10,cursor:"pointer",fontWeight:on?600:400}}>
                      {item.icon} {on?"✓ ":""}{item.label}
                    </button>;
                  })}
                </div>
              </div>
              <LiveEstimate/>
            </div>
          )}

          {/* ════════════════════════════════════════
              SECTION: PRICING
          ════════════════════════════════════════ */}
          {activeSection==="pricing"&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{background:C.lightBlue,borderRadius:8,padding:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted}}>Formula estimate</div>
                  <ProvenanceBadge type="curated"/>
                </div>
                {locality?(()=>{const e=calcEstimate();const gst=calcGST(e.total);return(
                  <div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:gst.amount?8:0}}>
                      <div>
                        <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:18,color:C.blue}}>
                          ₹{e.rate.toLocaleString()}<span style={{fontSize:11,fontWeight:400}}>/sqft</span>
                        </div>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted}}>Total: ₹{fmtL(e.total)}</div>
                      </div>
                      <div>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted}}>Range</div>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:13,fontWeight:600,color:C.dark}}>₹{fmtL(e.low)} – ₹{fmtL(e.high)}</div>
                      </div>
                    </div>
                    {gst.amount>0&&(
                      <div style={{background:"#FEF9C3",borderRadius:6,padding:"6px 10px",fontFamily:"Inter,sans-serif",fontSize:11,color:"#92400E"}}>
                        🧾 GST ({gst.rate}%): +₹{fmtL(gst.amount)} → Total with GST: ₹{fmtL(gst.total)}
                      </div>
                    )}
                  </div>
                );})():<div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.muted}}>Enter locality to see estimate</div>}
              </div>
              {priceCorrections.length>0&&(
                <div style={{background:"#F0FDF4",borderRadius:8,padding:"10px 12px",fontFamily:"Inter,sans-serif",fontSize:11,color:C.green}}>
                  ✓ {priceCorrections.length} correction(s) applied · Factor: {normCorrFactor.toFixed(2)}x
                </div>
              )}
              <div style={{borderRadius:8,border:`1px solid ${C.border}`,padding:12}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:C.dark,marginBottom:6}}>📊 Your Known Market Range (optional)</div>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,marginBottom:8}}>If you know local rates, enter them. AI will blend with market data.</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>Min ₹/sqft</label><input value={userMinPrice} onChange={e=>setUserMinPrice(e.target.value)} type="number" style={IS} placeholder="e.g. 5500"/></div>
                  <div><label style={LS}>Max ₹/sqft</label><input value={userMaxPrice} onChange={e=>setUserMaxPrice(e.target.value)} type="number" style={IS} placeholder="e.g. 8500"/></div>
                </div>
              </div>
              {constructionStatus!=="Ready to Move / Possession"&&locality&&(()=>{
                const e=calcEstimate();
                const postCompletion=Math.round(e.rate*(1+(appreciationOnCompletion||0)/100));
                const gst=calcGST(e.total);
                return(
                  <div style={{background:"#FFFBEB",borderRadius:8,border:"1px solid #FDE68A",padding:12}}>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,color:"#92400E",marginBottom:8}}>📈 Investor View — Under Construction</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:8}}>
                      {[["Book Now",`₹${e.rate.toLocaleString()}/sqft`,`${((constFactor||1)*100-100).toFixed(0)}% disc`],
                        ["At Completion",`~₹${postCompletion.toLocaleString()}/sqft`,`+${appreciationOnCompletion||0}%`],
                        ["Unit Gain",`₹${fmtL((postCompletion-e.rate)*(isPlot?plotArea:(+area||1200)))}`,`expected`]
                      ].map(([l,v,s])=>(
                        <div key={l} style={{textAlign:"center",background:"rgba(255,255,255,.6)",borderRadius:7,padding:"8px 4px"}}>
                          <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:"#92400E"}}>{l}</div>
                          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:C.dark}}>{v}</div>
                          <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:"#92400E"}}>{s}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{background:"#FEF9C3",borderRadius:6,padding:"6px 10px",fontFamily:"Inter,sans-serif",fontSize:11,color:"#92400E"}}>
                      🧾 {gst.note}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* ════════════════════════════════════════
              SECTION: UDS & LOAN
          ════════════════════════════════════════ */}
          {activeSection==="uds"&&!isPlot&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{background:"#EFF6FF",borderRadius:8,padding:"10px 12px",fontFamily:"Inter,sans-serif",fontSize:11,color:C.dark,lineHeight:1.6}}>
                📜 <strong>UDS</strong> = your % land ownership. Even in an apartment you co-own a fraction of the land — this shows its future value vs total holding costs.
              </div>

              <G id="uds_land" icon="🌍" title="Land & UDS">
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>Your UDS (%)</label>
                    <input value={udsPercent} onChange={e=>setUdsPercent(e.target.value)} type="number" style={IS} placeholder="e.g. 0.85"/>
                  </div>
                  <div><label style={LS}>Total Land Area (sqft)</label>
                    <input value={totalLandArea} onChange={e=>setTotalLandArea(e.target.value)} type="number" style={IS} placeholder="e.g. 43560"/>
                  </div>
                </div>
                {udsPercent&&totalLandArea&&(
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.blue,fontWeight:600}}>
                    Your land share: {(parseFloat(totalLandArea)*parseFloat(udsPercent)/100).toFixed(1)} sqft
                  </div>
                )}
              </G>

              <G id="uds_loan" icon="🏦" title="Loan Details">
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>Loan Amount (₹)</label>
                    <input value={loanAmount} onChange={e=>setLoanAmount(e.target.value)} type="number" style={IS} placeholder="e.g. 60,00,000"/>
                  </div>
                  <div><label style={LS}>Down Payment (₹)</label>
                    <input value={downPayment} onChange={e=>setDownPayment(e.target.value)} type="number" style={IS} placeholder="e.g. 15,00,000"/>
                  </div>
                </div>
                <div>
                  <label style={LS}>Interest Rate — <strong style={{color:C.dark}}>{loanInterestRate}%</strong></label>
                  <input type="range" min={6} max={14} step={0.1} value={loanInterestRate} onChange={e=>setLoanInterestRate(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                  <div style={{display:"flex",justifyContent:"space-between",fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted,marginTop:2}}><span>6%</span><span>14%</span></div>
                </div>
                <div>
                  <label style={LS}>Tenure — <strong style={{color:C.dark}}>{loanTenureYears} yrs</strong></label>
                  <input type="range" min={5} max={30} value={loanTenureYears} onChange={e=>setLoanTenureYears(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                </div>
              </G>

              <G id="uds_costs" icon="💸" title="Annual Holding Costs">
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div><label style={LS}>Maintenance (₹/yr)</label>
                    <input value={annualMaintenance} onChange={e=>setAnnualMaintenance(e.target.value)} type="number" style={IS} placeholder="e.g. 42,000"/>
                  </div>
                  <div><label style={LS}>Repairs (₹/yr)</label>
                    <input value={annualRepairs} onChange={e=>setAnnualRepairs(e.target.value)} type="number" style={IS} placeholder="e.g. 15,000"/>
                  </div>
                  <div><label style={LS}>Property Tax (₹/yr)</label>
                    <input value={propertyTaxAnnual} onChange={e=>setPropertyTaxAnnual(e.target.value)} type="number" style={IS} placeholder="e.g. 8,000"/>
                  </div>
                  <div>
                    <label style={LS}>Land Appreciation — <strong style={{color:C.dark}}>{landAppreciationRate}%/yr</strong></label>
                    <input type="range" min={3} max={20} value={landAppreciationRate} onChange={e=>setLandAppreciationRate(+e.target.value)} style={{width:"100%",marginTop:4,accentColor:C.blue}}/>
                  </div>
                </div>
              </G>

              {/* UDS Results */}
              {udsPercent&&totalLandArea&&loanAmount&&(()=>{
                const P=parseFloat(loanAmount);
                const r=loanInterestRate/12/100;
                const n=loanTenureYears*12;
                const emi=P*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1);
                const totalPaid=emi*n;
                const totalInterest=totalPaid-P;
                const dp=parseFloat(downPayment)||0;
                const maintTotal=(parseFloat(annualMaintenance)||0)*loanTenureYears;
                const repairsTotal=(parseFloat(annualRepairs)||0)*loanTenureYears;
                const taxTotal=(parseFloat(propertyTaxAnnual)||0)*loanTenureYears;
                const totalSpent=totalPaid+dp+maintTotal+repairsTotal+taxTotal;
                const myLandSqft=parseFloat(totalLandArea)*parseFloat(udsPercent)/100;
                const currentLandValue=myLandSqft*calcEstimate().rate;
                const futureLandValue=currentLandValue*Math.pow(1+landAppreciationRate/100,loanTenureYears);
                const netPosition=futureLandValue-totalSpent;
                return(
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <div style={{background:C.navy,borderRadius:10,padding:"14px 16px"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                        <div>
                          <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#94A3B8"}}>Monthly EMI</div>
                          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:18,color:"#F8FAFB"}}>₹{Math.round(emi).toLocaleString()}</div>
                        </div>
                        <div>
                          <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#94A3B8"}}>Total Interest</div>
                          <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:18,color:"#FCA5A5"}}>₹{fmtL(totalInterest)}</div>
                        </div>
                      </div>
                    </div>
                    <div style={{background:"#fff",borderRadius:10,border:`1px solid ${C.border}`,padding:12}}>
                      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:C.dark,marginBottom:8}}>💸 Total Spend Over {loanTenureYears} Years</div>
                      {[["Down Payment",dp],["Principal",P],["Interest",totalInterest],["Maintenance",maintTotal],["Repairs",repairsTotal],["Property Tax",taxTotal]].map(([l,v])=>(
                        <div key={l} style={{display:"flex",justifyContent:"space-between",fontFamily:"Inter,sans-serif",fontSize:12,padding:"3px 0"}}>
                          <span style={{color:C.muted}}>{l}</span>
                          <span style={{color:C.dark,fontWeight:600}}>₹{fmtL(v)}</span>
                        </div>
                      ))}
                      <div style={{borderTop:`1px solid ${C.border}`,marginTop:6,paddingTop:8,display:"flex",justifyContent:"space-between"}}>
                        <span style={{fontFamily:"Inter,sans-serif",fontSize:13,fontWeight:700,color:C.dark}}>Total Spent</span>
                        <span style={{fontFamily:"Inter,sans-serif",fontSize:14,fontWeight:700,color:C.red}}>₹{fmtL(totalSpent)}</span>
                      </div>
                    </div>
                    <div style={{background:"#F0FDF4",borderRadius:10,border:"1px solid #86EFAC",padding:12}}>
                      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:C.green,marginBottom:6}}>🌱 UDS Land Value Growth</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                        {[["Now",currentLandValue],["At Loan End",futureLandValue],["Land Gain",futureLandValue-currentLandValue]].map(([l,v],i)=>(
                          <div key={l} style={{textAlign:"center",background:"#fff",borderRadius:8,padding:"9px 6px"}}>
                            <div style={{fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted}}>{l}</div>
                            <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:i===2?C.blue:i===1?C.green:C.dark}}>₹{fmtL(v)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{background:netPosition>=0?"#F0FDF4":"#FFF7F5",borderRadius:10,
                      border:`1px solid ${netPosition>=0?"#86EFAC":"#FED7CC"}`,padding:12}}>
                      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:netPosition>=0?C.green:C.red,marginBottom:4}}>
                        {netPosition>=0?"✅ Positive Net Position":"⚠️ Negative Net Position"}
                      </div>
                      <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,lineHeight:1.7}}>
                        Land value (₹{fmtL(futureLandValue)}) {netPosition>=0?"exceeds":"is less than"} total spent (₹{fmtL(totalSpent)}) by{" "}
                        <strong style={{color:netPosition>=0?C.green:C.red}}>₹{fmtL(Math.abs(netPosition))}</strong>.
                      </div>
                    </div>
                  </div>
                );
              })()}
              {(!udsPercent||!totalLandArea||!loanAmount)&&(
                <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.muted,textAlign:"center",padding:20}}>
                  Fill UDS %, total land area, and loan amount above to see calculations.
                </div>
              )}
            </div>
          )}

          {error&&<div style={{color:C.red,fontFamily:"Inter,sans-serif",fontSize:11,padding:"8px 12px",
            background:"#FFF5F5",borderRadius:8,marginTop:8,wordBreak:"break-all"}}>{error}</div>}

          <button onClick={analyze} disabled={loading||!locality.trim()}
            style={{marginTop:12,width:"100%",background:loading?C.muted:C.navy,color:"#fff",border:"none",
              borderRadius:8,padding:"13px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,
              cursor:loading?"default":"pointer",opacity:!locality.trim()?0.6:1}}>
            {loading?"Analyzing…":"Analyze Price Accuracy →"}
          </button>
        </div>
      )}


      {/* ══════════════════════════════════════════════════════════════════
          RESULTS — shown for Full Valuation mode
      ══════════════════════════════════════════════════════════════════ */}
      {mode==="full"&&result&&(()=>{
        const vc=verdictColor(result.accuracy_verdict);
        const aiRate=result.market_rate_sqft||result.our_estimate?.rate;
        const ourRate=result.our_estimate?.rate||aiRate;
        const diff=Math.round(((aiRate-ourRate)/ourRate)*100);
        const blendedRate=userMinPrice&&userMaxPrice?Math.round((aiRate*2+(+userMinPrice+(+userMaxPrice))/2)/3):aiRate;
        const estArea=isPlot?plotArea:area;
        return(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>

            {/* Header */}
            <div style={{background:C.navy,borderRadius:12,padding:"18px 20px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <div style={{color:"#94A3B8",fontSize:10,fontFamily:"Inter,sans-serif",textTransform:"uppercase",letterSpacing:1.2}}>
                  {locality}, {city} · {propType} {!isPlot&&`· ${bhk}`}
                </div>
                <ProvenanceBadge type="ai"/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                <div>
                  <div style={{color:"#F8FAFB",fontSize:22,fontFamily:"serif",marginBottom:2}}>
                    ₹{aiRate?.toLocaleString()}<span style={{fontSize:13,color:"#94A3B8"}}>/sqft (AI Market)</span>
                  </div>
                  {userMinPrice&&userMaxPrice&&<div style={{color:"#94A3B8",fontSize:12,fontFamily:"Inter,sans-serif"}}>
                    Blended: ₹{blendedRate.toLocaleString()}/sqft · ₹{fmtL(blendedRate*estArea)}
                  </div>}
                  <div style={{color:"#94A3B8",fontSize:12,fontFamily:"Inter,sans-serif",marginTop:2}}>
                    Range: ₹{fmtL(result.low_estimate)} – ₹{fmtL(result.high_estimate)}
                  </div>
                  {result.gst_applicable&&result.gst_amount>0&&(
                    <div style={{color:"#FCD34D",fontSize:11,fontFamily:"Inter,sans-serif",marginTop:3}}>
                      + GST ({result.gst_rate_pct}%): ₹{fmtL(result.gst_amount)} → Total: ₹{fmtL(result.total_with_gst)}
                    </div>
                  )}
                </div>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5}}>
                  <div style={{background:vc,color:"#fff",borderRadius:8,padding:"5px 14px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13}}>{result.accuracy_verdict}</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#94A3B8"}}>
                    {result.price_trend==="Rising"?"📈":result.price_trend==="Declining"?"📉":"➡️"} {result.price_trend} · {result.yoy_appreciation_pct}% YoY
                  </div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#94A3B8"}}>Best for: <strong style={{color:"#F8FAFB"}}>{result.best_for}</strong></div>
                </div>
              </div>
            </div>

            {/* Score cards */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(96px,1fr))",gap:8}}>
              {[
                {l:"Formula Est.",v:"₹"+ourRate?.toLocaleString()+"/sqft",sub:"Amenity+Infra+Civic",c:C.muted},
                {l:"AI Market Rate",v:"₹"+aiRate?.toLocaleString()+"/sqft",sub:result.verdict_reason?.slice(0,50),c:vc},
                {l:"Gap",v:(diff>0?"+":"")+diff+"%",sub:Math.abs(diff)<5?"Aligned":Math.abs(diff)<15?"Moderate":"Large variance",c:Math.abs(diff)<5?C.green:Math.abs(diff)<15?C.amber:C.red},
              ].map(m=>(
                <div key={m.l} style={{background:"#fff",borderRadius:9,border:`1px solid ${C.border}`,padding:10}}>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginBottom:2}}>{m.l}</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:m.c}}>{m.v}</div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginTop:2,lineHeight:1.4}}>{m.sub}</div>
                </div>
              ))}
            </div>

            {/* Price projection chart */}
            {aiRate&&(()=>{
              const yoy=result.yoy_appreciation_pct||8;
              const pts=[
                {yr:"Now",r:aiRate,t:aiRate*estArea},
                {yr:"1Y",r:Math.round(aiRate*Math.pow(1+yoy/100,1)),t:0},
                {yr:"3Y",r:Math.round(aiRate*Math.pow(1+yoy/100,3)),t:0},
                {yr:"5Y",r:Math.round(aiRate*Math.pow(1+yoy/100,5)),t:0},
                {yr:"10Y",r:Math.round(aiRate*Math.pow(1+yoy/100,10)),t:0},
              ].map(p=>({...p,t:p.r*estArea}));
              const maxR=Math.max(...pts.map(p=>p.r));
              const colors=["#94A3B8","#60A5FA","#F59E0B","#34D399","#1E6B4A"];
              return(
                <div style={{background:"#fff",borderRadius:10,border:"1px solid "+C.border,padding:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark}}>📈 Price Projection</div>
                    <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.green,fontWeight:600}}>{yoy}% YoY est.</div>
                  </div>
                  <div style={{display:"flex",alignItems:"flex-end",gap:8,height:70,marginBottom:4}}>
                    {pts.map((pt,i)=>{
                      const h=Math.max(12,Math.round((pt.r/maxR)*60));
                      return(
                        <div key={pt.yr} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                          <div style={{fontFamily:"Inter,sans-serif",fontSize:8,fontWeight:700,color:colors[i]}}>₹{pt.r>=10000?Math.round(pt.r/1000)+"k":pt.r.toLocaleString()}</div>
                          <div style={{width:"100%",background:colors[i],borderRadius:"3px 3px 0 0",height:h+"px",opacity:0.9}}/>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:10}}>
                    {pts.map(pt=><div key={pt.yr} style={{flex:1,textAlign:"center",fontFamily:"Inter,sans-serif",fontSize:9,color:C.muted}}>{pt.yr}</div>)}
                  </div>
                  <div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.green,fontWeight:600,textAlign:"center"}}>
                    10Y gain: ₹{fmtL(pts[4].t-pts[0].t)} ({Math.round((pts[4].t-pts[0].t)/pts[0].t*100)}%)
                  </div>
                </div>
              );
            })()}

            {/* Insights */}
            <div style={{background:"#fff",borderRadius:10,border:`1px solid ${C.border}`,padding:13}}>
              <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,color:C.dark,marginBottom:8}}>📍 Market Insights</div>
              <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,lineHeight:1.7,marginBottom:6}}>{result.locality_insight}</div>
              {[
                result.water_impact&&["💧",result.water_impact],
                result.floor_impact&&["🏢",result.floor_impact],
                result.developer_tier_impact&&["🏗️",result.developer_tier_impact],
                result.approval_impact&&["📋",result.approval_impact],
                result.view_premium_note&&["🏞️",result.view_premium_note],
                result.sunlight_assessment&&["☀️",result.sunlight_assessment],
              ].filter(Boolean).map(([icon,txt],i)=>(
                <div key={i} style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,marginTop:4}}>{icon} {txt}</div>
              ))}
            </div>

            {/* Score breakdown */}
            <div style={{background:"#fff",borderRadius:10,border:`1px solid ${C.border}`,padding:13}}>
              <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,color:C.dark,marginBottom:10}}>Score Breakdown</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[{l:"Amenity Score",v:amenityScore,note:result.amenity_score_impact},{l:"Civic Score",v:civicScore,note:result.civic_impact}].map(s=>(
                  <div key={s.l} style={{background:C.bg,borderRadius:8,padding:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <div style={{fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:600,color:C.dark}}>{s.l}</div>
                      <div style={{background:scoreColor(s.v),color:"#fff",borderRadius:5,padding:"1px 8px",fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:11}}>{s.v}</div>
                    </div>
                    <div style={{background:C.border,borderRadius:99,height:5}}><div style={{background:scoreColor(s.v),height:"100%",width:`${s.v}%`,borderRadius:99}}/></div>
                    {s.note&&<div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,marginTop:5,lineHeight:1.4}}>{s.note}</div>}
                  </div>
                ))}
              </div>
            </div>

            {/* Elder / kid friendliness */}
            {(result.elder_friendliness||result.kid_friendliness)&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[["👴 Elder Friendly",result.elder_friendliness],["👶 Kid Friendly",result.kid_friendliness]].filter(([,v])=>v).map(([label,val])=>{
                  const part=val?.split(" - "); const rating=part?.[0]; const reason=part?.[1];
                  const col=rating==="Good"?C.green:rating==="Average"?C.amber:C.red;
                  return(
                    <div key={label} style={{background:"#fff",borderRadius:9,border:`1px solid ${C.border}`,padding:11}}>
                      <div style={{fontFamily:"Inter,sans-serif",fontSize:11,fontWeight:600,color:C.dark,marginBottom:4}}>{label}</div>
                      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:14,color:col,marginBottom:3}}>{rating}</div>
                      {reason&&<div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,lineHeight:1.4}}>{reason}</div>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Under Construction investor view */}
            {result.isUC&&result.completion_price_estimate&&(
              <div style={{background:"#FFFBEB",borderRadius:10,border:"1px solid #FDE68A",padding:14}}>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:12,color:"#92400E",marginBottom:10}}>📈 Investment Analysis — Under Construction</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(96px,1fr))",gap:8,marginBottom:8}}>
                  {[["Book Now At",`₹${aiRate?.toLocaleString()}/sqft`,"#FEF9C3"],["Est. At Possession",`₹${result.completion_price_estimate.toLocaleString()}/sqft`,"#F0FDF4"],["Expected Gain",`+${result.completion_appreciation_pct}%`,"#EFF6FF"]].map(([l,v,bg])=>(
                    <div key={l} style={{textAlign:"center",background:bg,borderRadius:8,padding:"10px 6px"}}>
                      <div style={{fontFamily:"Inter,sans-serif",fontSize:10,color:"#92400E"}}>{l}</div>
                      <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:13,color:C.dark}}>{v}</div>
                    </div>
                  ))}
                </div>
                {result.gst_note&&<div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:"#92400E",marginBottom:4}}>🧾 {result.gst_note}</div>}
                {result.investment_recommendation&&<div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark}}>{result.investment_recommendation}</div>}
              </div>
            )}

            {/* Comparables */}
            {result.comparable_projects?.length>0&&(
              <div style={{background:"#fff",borderRadius:10,border:"1px solid "+C.border,padding:12}}>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,color:C.dark,marginBottom:8}}>🏢 Comparable Projects</div>
                {result.comparable_projects.map((p,i)=>{
                  const isObj=p&&typeof p==="object";
                  const name=isObj?p.name:p; const rate=isObj?p.rate_sqft:null; const link=isObj?p.maps_link:null; const dist=isObj?p.distance:null;
                  return(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                      padding:"8px 0",borderBottom:i<result.comparable_projects.length-1?"1px solid "+C.border:"none"}}>
                      <div>
                        <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,fontWeight:500}}>{name}</div>
                        {(rate||dist)&&<div style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.muted,marginTop:1}}>{rate}{dist&&` · ${dist}`}</div>}
                      </div>
                      {link&&<a href={link} target="_blank" rel="noopener noreferrer"
                        style={{fontFamily:"Inter,sans-serif",fontSize:11,color:C.blue,fontWeight:600,textDecoration:"none",marginLeft:10}}>📍 Map</a>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Red flags, resale, yield, negotiation */}
            {result.red_flags?.length>0&&(
              <div style={{background:"#FFF7F5",borderRadius:10,border:"1px solid #FED7CC",padding:12}}>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,color:C.red,marginBottom:6}}>🚩 Watch Out For</div>
                {result.red_flags.map((f,i)=><div key={i} style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark,padding:"2px 0"}}>• {f}</div>)}
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div style={{background:"#F0FDF4",borderRadius:9,border:"1px solid #86EFAC",padding:11}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:600,color:C.green,marginBottom:2}}>Resale Potential</div>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:15,color:C.green}}>{result.resale_potential}</div>
              </div>
              <div style={{background:C.lightBlue,borderRadius:9,border:"1px solid #BFDBFE",padding:11}}>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:10,fontWeight:600,color:C.blue,marginBottom:2}}>Rental Yield</div>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:700,fontSize:15,color:C.blue}}>{result.rental_yield_pct}% p.a.</div>
              </div>
            </div>
            {result.negotiation_tip&&(
              <div style={{background:"#FFFBEB",borderRadius:9,border:"1px solid #FDE68A",padding:11}}>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:11,color:"#92400E",marginBottom:2}}>💡 Negotiation Tip</div>
                <div style={{fontFamily:"Inter,sans-serif",fontSize:12,color:C.dark}}>{result.negotiation_tip}</div>
              </div>
            )}

            {/* Price feedback */}
            {showFeedback&&!feedback&&(
              <div style={{background:"#fff",borderRadius:10,border:`1px solid ${C.border}`,padding:14}}>
                <div style={{fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,color:C.dark,marginBottom:6}}>🎯 Is this price accurate for your area?</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <div><label style={LS}>Min ₹/sqft you've seen</label><input value={userMinPrice} onChange={e=>setUserMinPrice(e.target.value)} type="number" style={IS}/></div>
                  <div><label style={LS}>Max ₹/sqft you've seen</label><input value={userMaxPrice} onChange={e=>setUserMaxPrice(e.target.value)} type="number" style={IS}/></div>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{setFeedback({type:"agree",msg:"Thanks! Marked as accurate."});setShowFeedback(false);}}
                    style={{flex:1,background:"#F0FDF4",border:"1px solid #86EFAC",color:C.green,borderRadius:8,padding:"8px",fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,cursor:"pointer"}}>✓ Accurate</button>
                  <button onClick={submitCorrection} disabled={!userMinPrice||!userMaxPrice}
                    style={{flex:2,background:userMinPrice&&userMaxPrice?C.blue:C.muted,color:"#fff",border:"none",borderRadius:8,padding:"8px",fontFamily:"Inter,sans-serif",fontWeight:600,fontSize:12,cursor:userMinPrice&&userMaxPrice?"pointer":"default"}}>Save Range → AI will learn & adjust</button>
                </div>
              </div>
            )}
            {feedback&&<div style={{background:"#F0FDF4",borderRadius:9,border:"1px solid #86EFAC",padding:"11px 13px",fontFamily:"Inter,sans-serif",fontSize:12,color:C.green}}>✓ {feedback.msg}</div>}
          </div>
        );
      })()}
    </div>
  );
}

function AppInner(){
  const [tab,setTab]=useState("home");
  const [analyzeQuery,setAnalyzeQuery]=useState("");
  useAppData(); // loads ETL data into REGION_CLUSTERS + INDIA_METRO_STATIONS

  const handleStateClick=(stateName)=>{
    setAnalyzeQuery(stateName);
    setTab("analyze");
  };

  return(
    <div style={{minHeight:"100vh",background:C.bg}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');`}</style>
      <div style={{position:"sticky",top:0,zIndex:1000,boxShadow:"0 2px 12px rgba(0,0,0,0.18)"}}>
        <div style={{background:C.navy,padding:"8px 14px",display:"flex",alignItems:"center",gap:7}}>
          <span style={{fontSize:15}}>🇮🇳</span>
          <span style={{color:"#F8FAFB",fontFamily:"serif",fontSize:14,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>Bharat Land Intelligence</span>
        </div>
        <div style={{background:"#1E293B",display:"flex",gap:0,padding:"3px 6px 5px"}}>
          {[["home","🏠","Home"],["analyze","🔍","Analyze"],["screen","🎯","Screener"],["pricer","🏘️","Pricer"]].map(([k,icon,l])=>(
            <button key={k} onClick={()=>setTab(k)}
              style={{flex:1,minWidth:0,background:tab===k?C.blue:"transparent",color:tab===k?"#fff":"#94A3B8",
                border:"none",borderRadius:6,padding:"7px 4px",fontFamily:"Inter,sans-serif",fontWeight:600,
                fontSize:11,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:1,
                margin:"0 2px",transition:"background 0.15s"}}>
              <span style={{fontSize:14,lineHeight:1}}>{icon}</span>
              <span style={{whiteSpace:"nowrap"}}>{l}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{maxWidth:680,margin:"0 auto",padding:"16px 13px 60px"}}>
        {tab==="home"&&<HomeTab onStateSelect={handleStateClick} onNavigate={setTab}/>}
        {tab==="analyze"&&<AnalyzeTab key={analyzeQuery} initialQuery={analyzeQuery} onClear={()=>{setAnalyzeQuery("");setTab("home");}}/>}
        {tab==="screen"&&<ScreenerTab/>}
        {tab==="pricer"&&<PricerTab/>}
      </div>
      <div style={{textAlign:"center",padding:"10px",fontFamily:"Inter,sans-serif",fontSize:10,color:C.muted,borderTop:`1px solid ${C.border}`}}>
        AI-generated analysis · Not financial advice · Verify before investing
      </div>
    </div>
  );
}

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("App error:", error, info); }
  render() {
    if (this.state.error) return (
      <div style={{padding:24,fontFamily:"Inter,sans-serif",color:"#C84B31",textAlign:"center"}}>
        <div style={{fontSize:18,marginBottom:8}}>⚠️ Something went wrong</div>
        <div style={{fontSize:12,color:"#64748B"}}>{this.state.error.message}</div>
        <button onClick={()=>this.setState({error:null})} style={{marginTop:12,padding:"8px 16px",background:"#0F1B2D",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontFamily:"Inter,sans-serif"}}>
          Try again
        </button>
      </div>
    );
    return this.props.children;
  }
}
export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
