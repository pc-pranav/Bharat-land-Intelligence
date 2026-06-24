"""
03_build_region_clusters.py
===========================
Joins metro_stations.json + infrastructure_pipelines.json, computes a
deterministic infrastructure proximity score for each region cluster, and
outputs REGION_CLUSTERS.json (consumed by App.jsx at runtime) and
metro_stations_flat.json (consumed by the metro connectivity card).

Scoring formula — infrastructure proximity score (0–100):
  For each region cluster centroid, scan all metro stations and infra
  projects. Compute a weighted inverse-distance score:

    station_score  = Σ  weight(status) / (1 + dist_km)  [stations within 10km]
    project_score  = Σ  weight(status) * radius_overlap  [projects within 50km]
    infra_score    = clamp(station_score * 35 + project_score * 65, 0, 100)

  Status weights:
    operational        → 1.0
    under_construction → 0.7  (priced in but not yet real)
    approved           → 0.4
    pre_construction   → 0.3
    proposed           → 0.1

  The infra_score then adjusts the base region score:
    final_score = base_score * 0.65 + infra_score * 0.35

  This preserves the curated base score (which accounts for economic and
  population factors the infra data can't capture) while letting real
  infrastructure data move the needle up or down.

Run:
    python 03_build_region_clusters.py

Inputs:
    data/output/metro_stations.json         (from script 01)
    data/output/infrastructure_pipelines.json (from script 02)

Outputs:
    data/output/REGION_CLUSTERS.json        → copied to src/data/
    data/output/metro_stations_flat.json    → copied to src/data/
    data/output/03_build_log.json           → run quality log
"""

import json
import math
import logging
import sys
import shutil
from pathlib import Path
from typing import Optional
from datetime import datetime, UTC

import pandas as pd

# ── Logging ───────────────────────────────────────────────────────────────────
ETL_DIR = Path(__file__).parent
SRC_DATA = ETL_DIR.parent / "src" / "data"
SRC_DATA.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(ETL_DIR / "data/processed/03_build.log"),
    ],
)
log = logging.getLogger("03_clusters")

OUTPUT_DIR = ETL_DIR / "data/output"

# ── Load inputs ───────────────────────────────────────────────────────────────
def load_json(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(
            f"\n {path} not found.\n"
            f"    Run script 01 and 02 first:\n"
            f"    python 01_ingest_metro_stations.py\n"
            f"    python 02_ingest_infrastructure.py"
        )
    with open(path) as f:
        return json.load(f)


# ── Seed region clusters ───────────────────────────────────────────────────────
# Base scores come from computeGrowthScore formula anchors (same values as
# the scoring anchors in App.jsx SYS prompt — keeping them in sync is critical).
# The ETL adjusts these scores using real infra proximity data.
SEED_CLUSTERS = [
    # Karnataka
    {"state":"Karnataka",     "name":"Bengaluru East (Whitefield Belt)",        "lat":12.97, "lng":77.75, "base_score":80},
    {"state":"Karnataka",     "name":"Bengaluru North (Devanahalli/Airport)",   "lat":13.24, "lng":77.71, "base_score":74},
    {"state":"Karnataka",     "name":"Bengaluru South (Electronic City)",       "lat":12.85, "lng":77.66, "base_score":72},
    {"state":"Karnataka",     "name":"Mysuru Region",                           "lat":12.30, "lng":76.64, "base_score":62},
    {"state":"Karnataka",     "name":"Mangaluru Coastal Belt",                  "lat":12.87, "lng":74.84, "base_score":58},
    {"state":"Karnataka",     "name":"Hubli-Dharwad",                           "lat":15.36, "lng":75.12, "base_score":54},
    # Maharashtra
    {"state":"Maharashtra",   "name":"Mumbai Metropolitan Region",              "lat":19.08, "lng":72.88, "base_score":72},
    {"state":"Maharashtra",   "name":"Pune East (Hinjewadi/Wakad)",             "lat":18.59, "lng":73.74, "base_score":76},
    {"state":"Maharashtra",   "name":"Navi Mumbai",                             "lat":19.03, "lng":73.02, "base_score":70},
    {"state":"Maharashtra",   "name":"Thane Belt",                              "lat":19.22, "lng":72.98, "base_score":66},
    {"state":"Maharashtra",   "name":"Nagpur Region",                           "lat":21.15, "lng":79.09, "base_score":55},
    {"state":"Maharashtra",   "name":"Nashik Region",                           "lat":20.00, "lng":73.79, "base_score":56},
    # Tamil Nadu
    {"state":"Tamil Nadu",    "name":"Chennai OMR Corridor",                    "lat":12.90, "lng":80.23, "base_score":70},
    {"state":"Tamil Nadu",    "name":"Chennai West (Porur/Poonamallee)",        "lat":13.04, "lng":80.16, "base_score":64},
    {"state":"Tamil Nadu",    "name":"Coimbatore Region",                       "lat":11.00, "lng":76.97, "base_score":56},
    {"state":"Tamil Nadu",    "name":"Madurai Region",                          "lat":9.93,  "lng":78.12, "base_score":50},
    {"state":"Tamil Nadu",    "name":"Tiruchirappalli Region",                  "lat":10.80, "lng":78.69, "base_score":48},
    # Telangana
    {"state":"Telangana",     "name":"Hyderabad West (Gachibowli/HITEC City)", "lat":17.44, "lng":78.38, "base_score":83},
    {"state":"Telangana",     "name":"Hyderabad North (Kompally/Medchal)",     "lat":17.60, "lng":78.49, "base_score":66},
    {"state":"Telangana",     "name":"Hyderabad South (Shamshabad)",           "lat":17.24, "lng":78.43, "base_score":58},
    {"state":"Telangana",     "name":"Warangal Region",                        "lat":18.00, "lng":79.58, "base_score":48},
    # Gujarat
    {"state":"Gujarat",       "name":"Ahmedabad-Gandhinagar Belt",             "lat":23.03, "lng":72.58, "base_score":72},
    {"state":"Gujarat",       "name":"Surat Region",                           "lat":21.17, "lng":72.83, "base_score":64},
    {"state":"Gujarat",       "name":"Vadodara Region",                        "lat":22.31, "lng":73.18, "base_score":60},
    {"state":"Gujarat",       "name":"Dholera SIR",                            "lat":22.27, "lng":72.19, "base_score":59},
    # Haryana / Delhi NCR
    {"state":"Haryana",       "name":"Gurugram (Cyber City/Golf Course Rd)",   "lat":28.47, "lng":77.03, "base_score":74},
    {"state":"Haryana",       "name":"Faridabad Region",                       "lat":28.41, "lng":77.31, "base_score":55},
    {"state":"Haryana",       "name":"Panchkula Region",                       "lat":30.69, "lng":76.86, "base_score":56},
    # Uttar Pradesh
    {"state":"Uttar Pradesh", "name":"Noida-Greater Noida Belt",               "lat":28.57, "lng":77.32, "base_score":67},
    {"state":"Uttar Pradesh", "name":"Lucknow Region",                         "lat":26.85, "lng":80.95, "base_score":56},
    {"state":"Uttar Pradesh", "name":"Agra Region",                            "lat":27.18, "lng":78.02, "base_score":46},
    # West Bengal
    {"state":"West Bengal",   "name":"Kolkata New Town/Rajarhat",              "lat":22.58, "lng":88.47, "base_score":64},
    {"state":"West Bengal",   "name":"Kolkata South",                          "lat":22.50, "lng":88.35, "base_score":58},
    {"state":"West Bengal",   "name":"Siliguri Region",                        "lat":26.72, "lng":88.43, "base_score":44},
]

# ── Scoring constants ──────────────────────────────────────────────────────────
STATUS_WEIGHTS = {
    "operational":        1.0,
    "under_construction": 0.7,
    "approved":           0.4,
    "pre_construction":   0.3,
    "proposed":           0.1,
    "stalled":            0.05,
    "cancelled":          0.0,
}

# ── Helpers ───────────────────────────────────────────────────────────────────
def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


# ── Core scoring ───────────────────────────────────────────────────────────────
def compute_infra_score(
    region_lat: float,
    region_lng: float,
    stations: list[dict],
    projects: list[dict],
) -> tuple[float, dict]:
    """
    Returns (infra_score 0–100, breakdown dict for debugging).
    """
    # ── Metro station contribution ──────────────────────────────────────────
    station_score = 0.0
    nearby_stations = []
    for s in stations:
        dist = haversine_km(region_lat, region_lng, s["lat"], s["lng"])
        if dist > 10.0:
            continue
        weight = STATUS_WEIGHTS.get(s["status"], 0.0)
        contribution = weight / (1.0 + dist)
        station_score += contribution
        nearby_stations.append({
            "name": s["station_name"], "city": s["city"],
            "dist_km": round(dist, 2), "status": s["status"],
            "contribution": round(contribution, 4),
        })

    # Normalise: calibrated to observed max (~4.0 for dense metro areas like Electronic City)
    station_score_normalised = clamp(station_score / 4.0 * 100, 0, 100)

    # ── Infrastructure project contribution ────────────────────────────────
    project_score = 0.0
    nearby_projects = []
    for p in projects:
        dist = haversine_km(region_lat, region_lng, p["lat"], p["lng"])
        radius = p.get("impact_radius_km", 5.0)
        if dist > max(radius, 50.0):  # consider all projects within 50km at minimum
            continue
        weight = STATUS_WEIGHTS.get(p["status"], 0.0)
        # Overlap factor: how much of the project's impact radius overlaps with region
        overlap = clamp(1.0 - (dist / max(radius * 2, 1.0)), 0.0, 1.0)
        contribution = weight * overlap * 10  # scale up for meaningful signal
        project_score += contribution
        nearby_projects.append({
            "name": p["name"], "type": p["type"], "status": p["status"],
            "dist_km": round(dist, 2), "overlap_factor": round(overlap, 3),
            "contribution": round(contribution, 4),
        })

    # Sort by contribution descending
    nearby_projects.sort(key=lambda x: -x["contribution"])
    nearby_stations.sort(key=lambda x: x["dist_km"])

    # Normalise project score: calibrated ceiling of 30 (5 projects × weight 0.7 × overlap 0.8 × scale 10)
    project_score_normalised = clamp(project_score / 30.0 * 100, 0, 100)

    # Weighted combination: stations are more immediately impactful
    infra_score = round(station_score_normalised * 0.35 + project_score_normalised * 0.65, 2)

    breakdown = {
        "station_score_raw":        round(station_score, 4),
        "station_score_normalised": round(station_score_normalised, 2),
        "project_score_raw":        round(project_score, 4),
        "project_score_normalised": round(project_score_normalised, 2),
        "infra_score":              infra_score,
        "nearby_stations":          nearby_stations[:5],
        "nearby_projects":          nearby_projects[:5],
    }
    return infra_score, breakdown


def blend_scores(base_score: float, infra_score: float) -> int:
    """
    Adjust base score using infra proximity as a bounded delta signal.
    The base score (from curated computeGrowthScore anchors) captures
    economic activity, population, and scarcity — which raw proximity
    data can't measure. Infra score adds/subtracts up to 8 points:
      infra_score > 50 → boost base by up to +8
      infra_score < 20 → reduce base by up to -5
      infra_score 20–50 → no adjustment
    This ensures infra data improves signal quality without overriding
    the curated intelligence that drives the base score.
    """
    if infra_score >= 50:
        delta = (infra_score - 50) / 50 * 8    # +0 to +8
    elif infra_score < 20:
        delta = (infra_score - 20) / 20 * 5    # -5 to 0
    else:
        delta = 0.0
    return int(round(clamp(base_score + delta, 0, 100)))


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 60)
    log.info("03_build_region_clusters.py")
    log.info("=" * 60)

    # Load inputs
    metro_data = load_json(OUTPUT_DIR / "metro_stations.json")
    infra_data = load_json(OUTPUT_DIR / "infrastructure_pipelines.json")

    stations  = metro_data["stations"]
    projects  = infra_data["projects"]
    log.info(f"Loaded: {len(stations)} metro stations, {len(projects)} infra projects")

    # Compute scores
    clusters_by_state: dict[str, list] = {}
    score_log = []

    for region in SEED_CLUSTERS:
        state = region["state"]
        infra_score, breakdown = compute_infra_score(
            region["lat"], region["lng"], stations, projects
        )
        final_score = blend_scores(region["base_score"], infra_score)

        entry = {
            "name":       region["name"],
            "lat":        region["lat"],
            "lng":        region["lng"],
            "score":      final_score,
            # Extra fields (not used by app currently, but available for future features)
            "_base_score":   region["base_score"],
            "_infra_score":  infra_score,
            "_nearby_stations": [s["name"] + f" ({s['dist_km']}km)" for s in breakdown["nearby_stations"][:3]],
            "_nearby_projects": [p["name"][:50] for p in breakdown["nearby_projects"][:3]],
        }

        if state not in clusters_by_state:
            clusters_by_state[state] = []
        clusters_by_state[state].append(entry)

        delta = final_score - region["base_score"]
        log.info(
            f"  {region['name']:45s}  base={region['base_score']:3d}  "
            f"infra={infra_score:5.1f}  final={final_score:3d}  "
            f"delta={delta:+d}"
        )
        score_log.append({**region, "infra_score": infra_score,
                          "final_score": final_score, "breakdown": breakdown})

    # ── Write REGION_CLUSTERS.json ─────────────────────────────────────────────
    rc_out = {
        "generated_at":   datetime.now(UTC).isoformat(),
        "total_regions":  sum(len(v) for v in clusters_by_state.values()),
        "states":         len(clusters_by_state),
        "clusters":       clusters_by_state,
    }
    rc_path = OUTPUT_DIR / "REGION_CLUSTERS.json"
    with open(rc_path, "w") as f:
        json.dump(rc_out, f, indent=2, ensure_ascii=False)
    log.info(f"\n REGION_CLUSTERS.json: {rc_out['total_regions']} regions across {rc_out['states']} states")

    # ── Write flat metro_stations for the app's metro card ─────────────────────
    flat_stations = [{
        "n": s["station_name"],
        "la": s["lat"],
        "lo": s["lng"],
        "ln": s["line"],
        "st": "op" if s["status"] == "operational" else "uc",
        "c":  s["city"],
    } for s in stations]

    flat_path = OUTPUT_DIR / "metro_stations_flat.json"
    with open(flat_path, "w") as f:
        json.dump({"generated_at": datetime.now(UTC).isoformat() ,
                   "stations": flat_stations}, f, ensure_ascii=False)
    log.info(f" metro_stations_flat.json: {len(flat_stations)} stations")

    # ── Write quality log ──────────────────────────────────────────────────────
    log_path = ETL_DIR / "data/processed/03_build_log.json"
    with open(log_path, "w") as f:
        json.dump({
            "run_at":       datetime.now(UTC).isoformat(),
            "stations_used": len(stations),
            "projects_used": len(projects),
            "regions":       score_log,
        }, f, indent=2, ensure_ascii=False)

    # ── Copy outputs to src/data/ so App.jsx can import directly ──────────────
    for src, dst_name in [
        (rc_path,   "REGION_CLUSTERS.json"),
        (flat_path, "metro_stations_flat.json"),
    ]:
        dst = SRC_DATA / dst_name
        shutil.copy2(src, dst)
        log.info(f" Copied -> {dst}")

    log.info("\nAll done. To use in App.jsx:")
    log.info("  import REGION_CLUSTERS from './data/REGION_CLUSTERS.json';")
    log.info("  import { stations } from './data/metro_stations_flat.json';")


if __name__ == "__main__":
    main()
