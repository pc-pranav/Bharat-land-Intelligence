"""
01_ingest_metro_stations.py
===========================
Reads raw metro station data (CSV from data.gov.in or a locally maintained
seed CSV), validates each row with Pydantic, cleans and normalises fields,
and writes data/output/metro_stations.json consumed by 03_build_region_clusters.py
and ultimately imported by the React app at runtime.

Data sources (in priority order):
  1. data/raw/metro_stations.csv   — drop a CSV from data.gov.in here
  2. SEED_STATIONS below           — curated fallback, all verified manually

Run:
    python 01_ingest_metro_stations.py

Outputs:
    data/output/metro_stations.json
"""

import json
import logging
import sys
from pathlib import Path
from typing import Optional
from datetime import datetime, UTC

import pandas as pd
from pydantic import BaseModel, field_validator, model_validator, ValidationError

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path(__file__).parent / "data/processed/01_ingest.log"),
    ],
)
log = logging.getLogger("01_metro")

# ── Paths ─────────────────────────────────────────────────────────────────────
ETL_DIR    = Path(__file__).parent
RAW_CSV    = ETL_DIR / "data/raw/metro_stations.csv"
OUTPUT_DIR = ETL_DIR / "data/output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Pydantic schema ───────────────────────────────────────────────────────────
VALID_STATUSES = {"operational", "under_construction", "proposed", "suspended"}
VALID_CITIES   = {
    "Bengaluru","Delhi","Hyderabad","Chennai","Mumbai","Kolkata",
    "Pune","Ahmedabad","Kochi","Jaipur","Lucknow","Nagpur","Noida",
    "Gurugram","Bhopal","Indore","Agra","Kanpur","Meerut","Surat",
    "Patna","Bhubaneswar","Visakhapatnam","Vijayawada","Thiruvananthapuram",
}

class MetroStation(BaseModel):
    city:         str
    station_name: str
    lat:          float
    lng:          float
    line:         str
    status:       str
    year_opened:  Optional[int] = None
    state:        Optional[str] = None
    network:      Optional[str] = None   # e.g. "Namma Metro", "DMRC", "HMRL"

    @field_validator("city")
    @classmethod
    def normalise_city(cls, v: str) -> str:
        v = v.strip().title()
        # Common alias normalisation
        aliases = {
            "Bangalore": "Bengaluru", "Mysore": "Mysuru",
            "Bombay": "Mumbai", "Calcutta": "Kolkata",
            "New Delhi": "Delhi", "Gurgaon": "Gurugram",
        }
        return aliases.get(v, v)

    @field_validator("station_name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        return v.strip().title()

    @field_validator("lat")
    @classmethod
    def valid_lat(cls, v: float) -> float:
        if not (6.0 <= v <= 37.5):
            raise ValueError(f"Latitude {v} outside India bounds (6–37.5°N)")
        return round(v, 6)

    @field_validator("lng")
    @classmethod
    def valid_lng(cls, v: float) -> float:
        if not (68.0 <= v <= 97.5):
            raise ValueError(f"Longitude {v} outside India bounds (68–97.5°E)")
        return round(v, 6)

    @field_validator("status")
    @classmethod
    def normalise_status(cls, v: str) -> str:
        v = v.strip().lower().replace(" ", "_").replace("-", "_")
        aliases = {
            "open": "operational", "active": "operational", "running": "operational",
            "uc": "under_construction", "construction": "under_construction",
            "u/c": "under_construction", "upcoming": "proposed",
            "planned": "proposed",
        }
        v = aliases.get(v, v)
        if v not in VALID_STATUSES:
            raise ValueError(f"Status '{v}' not in {VALID_STATUSES}")
        return v

    @field_validator("year_opened", mode="before")
    @classmethod
    def parse_year(cls, v) -> Optional[int]:
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return None
        try:
            yr = int(v)
            if not (1984 <= yr <= 2035):
                raise ValueError(f"Year {yr} outside plausible range 1984–2035")
            return yr
        except (ValueError, TypeError):
            return None

    @model_validator(mode="after")
    def set_state_from_city(self) -> "MetroStation":
        if not self.state:
            city_state = {
                "Bengaluru":"Karnataka","Mysuru":"Karnataka","Hubballi":"Karnataka",
                "Delhi":"Delhi","Noida":"Uttar Pradesh","Gurugram":"Haryana",
                "Hyderabad":"Telangana","Secunderabad":"Telangana",
                "Chennai":"Tamil Nadu","Coimbatore":"Tamil Nadu",
                "Mumbai":"Maharashtra","Pune":"Maharashtra","Nagpur":"Maharashtra",
                "Kolkata":"West Bengal","Siliguri":"West Bengal",
                "Kochi":"Kerala","Thiruvananthapuram":"Kerala",
                "Ahmedabad":"Gujarat","Surat":"Gujarat","Vadodara":"Gujarat",
                "Jaipur":"Rajasthan","Jodhpur":"Rajasthan",
                "Lucknow":"Uttar Pradesh","Agra":"Uttar Pradesh","Kanpur":"Uttar Pradesh",
                "Bhopal":"Madhya Pradesh","Indore":"Madhya Pradesh",
                "Patna":"Bihar","Bhubaneswar":"Odisha",
                "Visakhapatnam":"Andhra Pradesh","Vijayawada":"Andhra Pradesh",
                "Meerut":"Uttar Pradesh",
            }
            self.state = city_state.get(self.city, "Unknown")
        return self

    @model_validator(mode="after")
    def set_network(self) -> "MetroStation":
        if not self.network:
            city_network = {
                "Bengaluru":"Namma Metro (BMRCL)",
                "Delhi":"DMRC", "Noida":"NMRC", "Gurugram":"GMRC / Rapid Metro",
                "Hyderabad":"HMRL / L&T Metro",
                "Chennai":"CMRL",
                "Mumbai":"MMRCL",
                "Kolkata":"Kolkata Metro (KMRC)",
                "Pune":"PMRDA Metro",
                "Kochi":"KMRL",
                "Ahmedabad":"GMRC",
                "Jaipur":"Jaipur Metro Rail",
                "Lucknow":"LMRC",
                "Nagpur":"NMRCL (MahaMetro)",
                "Bhopal":"MPMRCL",
                "Indore":"MPMRCL",
                "Patna":"PMRC",
                "Bhubaneswar":"BMRC",
                "Surat":"Surat Metro",
                "Meerut":"RRTS (NCRTC)",
            }
            self.network = city_network.get(self.city, f"{self.city} Metro")
        return self


# ── Seed data (curated, verified coordinates) ─────────────────────────────────
# Used when no raw CSV is present. Covers all operational networks as of mid-2026.
# Sources: BMRCL, DMRC, HMRL, CMRL, KMRL, Wikipedia station infoboxes,
#          OpenStreetMap node exports cross-checked against Google Maps.
SEED_STATIONS = [
    # ── Bengaluru — Namma Metro ───────────────────────────────────────────────
    # Purple Line (Whitefield–Challaghatta)
    {"city":"Bengaluru","station_name":"Whitefield (Kadugodi)","lat":12.9882,"lng":77.7500,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Channasandra","lat":12.9943,"lng":77.7171,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Kadugodi Tree Park","lat":12.9921,"lng":77.7042,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Hopefarm Channasandra","lat":12.9885,"lng":77.6927,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Kundalahalli","lat":12.9842,"lng":77.6826,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Brookefield","lat":12.9815,"lng":77.6717,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Tin Factory","lat":12.9780,"lng":77.6646,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Krishnarajapura","lat":13.0022,"lng":77.6944,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Benniganahalli","lat":12.9916,"lng":77.6547,"line":"Purple","status":"operational","year_opened":2023},
    {"city":"Bengaluru","station_name":"Baiyappanahalli","lat":12.9948,"lng":77.6470,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Swami Vivekananda Road","lat":12.9895,"lng":77.6403,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Indiranagar","lat":12.9784,"lng":77.6408,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Halasuru","lat":12.9763,"lng":77.6259,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Trinity","lat":12.9698,"lng":77.6204,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"MG Road","lat":12.9756,"lng":77.6101,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Cubbon Park","lat":12.9789,"lng":77.5949,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Vidhana Soudha","lat":12.9788,"lng":77.5905,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Sir M Visveshwaraya","lat":12.9759,"lng":77.5796,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"Nadaprabhu Kempegowda (Majestic)","lat":12.9767,"lng":77.5713,"line":"Purple","status":"operational","year_opened":2011},
    {"city":"Bengaluru","station_name":"City Railway Station","lat":12.9774,"lng":77.5640,"line":"Purple","status":"operational","year_opened":2012},
    {"city":"Bengaluru","station_name":"Magadi Road","lat":12.9755,"lng":77.5570,"line":"Purple","status":"operational","year_opened":2012},
    {"city":"Bengaluru","station_name":"Hosahalli","lat":12.9701,"lng":77.5462,"line":"Purple","status":"operational","year_opened":2012},
    {"city":"Bengaluru","station_name":"Vijayanagar","lat":12.9669,"lng":77.5373,"line":"Purple","status":"operational","year_opened":2012},
    {"city":"Bengaluru","station_name":"Attiguppe","lat":12.9563,"lng":77.5341,"line":"Purple","status":"operational","year_opened":2012},
    {"city":"Bengaluru","station_name":"Deepanjali Nagar","lat":12.9468,"lng":77.5312,"line":"Purple","status":"operational","year_opened":2012},
    {"city":"Bengaluru","station_name":"Mysore Road","lat":12.9431,"lng":77.5233,"line":"Purple","status":"operational","year_opened":2012},
    {"city":"Bengaluru","station_name":"Pantharapalya","lat":12.9354,"lng":77.5183,"line":"Purple","status":"operational","year_opened":2015},
    {"city":"Bengaluru","station_name":"Nayandahalli","lat":12.9294,"lng":77.5098,"line":"Purple","status":"operational","year_opened":2015},
    {"city":"Bengaluru","station_name":"Rajarajeshwari Nagar","lat":12.9180,"lng":77.5022,"line":"Purple","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Jnanabharathi","lat":12.9117,"lng":77.5001,"line":"Purple","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Pattanagere","lat":12.9049,"lng":77.4960,"line":"Purple","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Kengeri Bus Terminal","lat":12.9004,"lng":77.4872,"line":"Purple","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Kengeri","lat":12.8972,"lng":77.4827,"line":"Purple","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Challaghatta","lat":12.8927,"lng":77.4769,"line":"Purple","status":"operational","year_opened":2021},
    # Green Line (Madavara–Silk Institute)
    {"city":"Bengaluru","station_name":"Madavara","lat":13.0938,"lng":77.5003,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Chikkabidarakallu","lat":13.0793,"lng":77.5052,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Manjunathanagar","lat":13.0653,"lng":77.5110,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Nagasandra","lat":13.0496,"lng":77.5173,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Dasarahalli","lat":13.0393,"lng":77.5226,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Jalahalli","lat":13.0290,"lng":77.5289,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Peenya Industry","lat":13.0227,"lng":77.5370,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Peenya","lat":13.0165,"lng":77.5432,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Goraguntepalya","lat":13.0094,"lng":77.5495,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Yeshwanthpur","lat":13.0271,"lng":77.5551,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Sandal Soap Factory","lat":13.0211,"lng":77.5618,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Mahalakshmi","lat":13.0133,"lng":77.5679,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Rajajinagar","lat":13.0042,"lng":77.5665,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Mahakavi Kuvempu Road","lat":12.9979,"lng":77.5696,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Srirampura","lat":12.9904,"lng":77.5706,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Mantri Square Sampige Road","lat":12.9862,"lng":77.5733,"line":"Green","status":"operational","year_opened":2016},
    {"city":"Bengaluru","station_name":"Chickpete","lat":12.9659,"lng":77.5762,"line":"Green","status":"operational","year_opened":2014},
    {"city":"Bengaluru","station_name":"Krishna Rajendra Market","lat":12.9606,"lng":77.5779,"line":"Green","status":"operational","year_opened":2014},
    {"city":"Bengaluru","station_name":"National College","lat":12.9537,"lng":77.5779,"line":"Green","status":"operational","year_opened":2014},
    {"city":"Bengaluru","station_name":"Lalbagh","lat":12.9509,"lng":77.5816,"line":"Green","status":"operational","year_opened":2014},
    {"city":"Bengaluru","station_name":"South End Circle","lat":12.9454,"lng":77.5854,"line":"Green","status":"operational","year_opened":2014},
    {"city":"Bengaluru","station_name":"Jayanagar","lat":12.9304,"lng":77.5845,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Rashtreeya Vidyalaya Road","lat":12.9226,"lng":77.5922,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Banashankari","lat":12.9137,"lng":77.5792,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Jaya Prakash Nagar","lat":12.9097,"lng":77.5846,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Puttenahalli","lat":12.9032,"lng":77.5895,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Yelachenahalli","lat":12.8961,"lng":77.5948,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Konanakunte Cross","lat":12.8862,"lng":77.5962,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Doddakallasandra","lat":12.8787,"lng":77.5976,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Vajarahalli","lat":12.8694,"lng":77.5989,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Talaghattapura","lat":12.8582,"lng":77.5943,"line":"Green","status":"operational","year_opened":2021},
    {"city":"Bengaluru","station_name":"Silk Institute","lat":12.8469,"lng":77.5812,"line":"Green","status":"operational","year_opened":2021},
    # Yellow Line (RV Road–Bommasandra, opened 10 Aug 2025)
    {"city":"Bengaluru","station_name":"Rashtreeya Vidyalaya Road","lat":12.9226,"lng":77.5922,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Ragigudda","lat":12.9090,"lng":77.6010,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Jayadeva Hospital","lat":12.9006,"lng":77.6105,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"BTM Layout","lat":12.8942,"lng":77.6148,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Central Silk Board","lat":12.9172,"lng":77.6220,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Hongasandra","lat":12.8840,"lng":77.6298,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Kudlu Gate","lat":12.8752,"lng":77.6390,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Singasandra","lat":12.8661,"lng":77.6482,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Hosa Road","lat":12.8558,"lng":77.6580,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Electronic City","lat":12.8399,"lng":77.6745,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Infosys Foundation Konappana Agrahara","lat":12.8326,"lng":77.6815,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Beratena Agrahara","lat":12.8264,"lng":77.6891,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Hebbagodi","lat":12.8170,"lng":77.6920,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Huskur Road","lat":12.8081,"lng":77.6941,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Bommasandra","lat":12.7951,"lng":77.6932,"line":"Yellow","status":"operational","year_opened":2025},
    {"city":"Bengaluru","station_name":"Delta Electronics Bommasandra","lat":12.7832,"lng":77.6912,"line":"Yellow","status":"operational","year_opened":2025},
    # Under construction
    {"city":"Bengaluru","station_name":"Silk Board (Blue Line)","lat":12.9172,"lng":77.6220,"line":"Blue Phase 2A","status":"under_construction","year_opened":None},
    {"city":"Bengaluru","station_name":"KR Puram","lat":13.0022,"lng":77.6944,"line":"Blue Phase 2A","status":"under_construction","year_opened":None},
    {"city":"Bengaluru","station_name":"Kempegowda International Airport","lat":13.1989,"lng":77.7068,"line":"Blue Phase 2B","status":"under_construction","year_opened":None},
    # ── Delhi — DMRC (sample of key stations; full list in raw CSV) ────────────
    {"city":"Delhi","station_name":"Rajiv Chowk","lat":28.6328,"lng":77.2197,"line":"Yellow","status":"operational","year_opened":2005},
    {"city":"Delhi","station_name":"AIIMS","lat":28.5689,"lng":77.2077,"line":"Yellow","status":"operational","year_opened":2005},
    {"city":"Delhi","station_name":"Hauz Khas","lat":28.5432,"lng":77.2066,"line":"Yellow","status":"operational","year_opened":2005},
    {"city":"Delhi","station_name":"New Delhi Railway Station","lat":28.6435,"lng":77.2193,"line":"Yellow","status":"operational","year_opened":2004},
    {"city":"Delhi","station_name":"Kashmere Gate","lat":28.6677,"lng":77.2285,"line":"Yellow","status":"operational","year_opened":2002},
    {"city":"Delhi","station_name":"Dwarka Sector 21","lat":28.5526,"lng":77.0593,"line":"Blue","status":"operational","year_opened":2010},
    {"city":"Delhi","station_name":"Noida City Centre","lat":28.5706,"lng":77.3588,"line":"Blue","status":"operational","year_opened":2009},
    {"city":"Delhi","station_name":"Botanical Garden","lat":28.5637,"lng":77.3370,"line":"Blue","status":"operational","year_opened":2010},
    {"city":"Delhi","station_name":"IGI Airport T3","lat":28.5565,"lng":77.0882,"line":"Orange (Airport Express)","status":"operational","year_opened":2011},
    {"city":"Delhi","station_name":"Janakpuri West","lat":28.6262,"lng":77.0855,"line":"Blue","status":"operational","year_opened":2010},
    {"city":"Delhi","station_name":"Lajpat Nagar","lat":28.5677,"lng":77.2394,"line":"Pink","status":"operational","year_opened":2018},
    {"city":"Delhi","station_name":"Mayur Vihar Phase 1","lat":28.6082,"lng":77.2968,"line":"Blue","status":"operational","year_opened":2005},
    {"city":"Delhi","station_name":"Anand Vihar","lat":28.6468,"lng":77.3158,"line":"Blue","status":"operational","year_opened":2011},
    {"city":"Delhi","station_name":"Samaypur Badli","lat":28.7327,"lng":77.1554,"line":"Yellow","status":"operational","year_opened":2010},
    {"city":"Noida","station_name":"Noida Sector 137","lat":28.5406,"lng":77.3869,"line":"Aqua","status":"operational","year_opened":2019},
    {"city":"Noida","station_name":"Pari Chowk","lat":28.4721,"lng":77.5062,"line":"Aqua","status":"operational","year_opened":2019},
    {"city":"Gurugram","station_name":"Sikanderpur","lat":28.4794,"lng":77.0906,"line":"Rapid Metro","status":"operational","year_opened":2013},
    {"city":"Gurugram","station_name":"Cyber City","lat":28.4950,"lng":77.0891,"line":"Rapid Metro","status":"operational","year_opened":2013},
    # ── Hyderabad — HMRL ──────────────────────────────────────────────────────
    {"city":"Hyderabad","station_name":"Miyapur","lat":17.4963,"lng":78.3485,"line":"Red","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"Hitech City","lat":17.4478,"lng":78.3768,"line":"Red","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"Ameerpet","lat":17.4376,"lng":78.4490,"line":"Red/Blue","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"LB Nagar","lat":17.3468,"lng":78.5499,"line":"Red","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"Nagole","lat":17.3699,"lng":78.5528,"line":"Blue","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"Raidurg","lat":17.4228,"lng":78.3800,"line":"Blue","status":"operational","year_opened":2018},
    {"city":"Hyderabad","station_name":"JBS Parade Ground","lat":17.4402,"lng":78.4980,"line":"Green","status":"operational","year_opened":2018},
    {"city":"Hyderabad","station_name":"MG Bus Station","lat":17.3764,"lng":78.4803,"line":"Red/Green","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"Dilsukhnagar","lat":17.3673,"lng":78.5266,"line":"Red","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"Uppal","lat":17.3967,"lng":78.5596,"line":"Blue","status":"operational","year_opened":2017},
    {"city":"Hyderabad","station_name":"Begumpet","lat":17.4456,"lng":78.4694,"line":"Blue","status":"operational","year_opened":2018},
    {"city":"Hyderabad","station_name":"Secunderabad West","lat":17.4343,"lng":78.4876,"line":"Blue","status":"operational","year_opened":2018},
    # ── Chennai — CMRL ────────────────────────────────────────────────────────
    {"city":"Chennai","station_name":"Wimco Nagar","lat":13.1437,"lng":80.2949,"line":"Line 1","status":"operational","year_opened":2015},
    {"city":"Chennai","station_name":"Chennai Central","lat":13.0828,"lng":80.2750,"line":"Line 1","status":"operational","year_opened":2015},
    {"city":"Chennai","station_name":"Koyambedu","lat":13.0694,"lng":80.1956,"line":"Line 1","status":"operational","year_opened":2015},
    {"city":"Chennai","station_name":"Chennai Airport","lat":12.9941,"lng":80.1708,"line":"Line 1","status":"operational","year_opened":2015},
    {"city":"Chennai","station_name":"Alandur","lat":12.9984,"lng":80.2064,"line":"Line 1","status":"operational","year_opened":2015},
    {"city":"Chennai","station_name":"Velachery","lat":12.9804,"lng":80.2209,"line":"Line 2","status":"operational","year_opened":2016},
    {"city":"Chennai","station_name":"St Thomas Mount","lat":13.0043,"lng":80.2025,"line":"Line 2","status":"operational","year_opened":2016},
    {"city":"Chennai","station_name":"Anna Nagar Tower","lat":13.0851,"lng":80.2098,"line":"Line 2","status":"operational","year_opened":2016},
    {"city":"Chennai","station_name":"Sholinganallur","lat":12.9004,"lng":80.2270,"line":"Line 2","status":"operational","year_opened":2023},
    # ── Mumbai ────────────────────────────────────────────────────────────────
    {"city":"Mumbai","station_name":"Versova","lat":19.1313,"lng":72.8164,"line":"Line 1","status":"operational","year_opened":2014},
    {"city":"Mumbai","station_name":"Andheri","lat":19.1197,"lng":72.8487,"line":"Line 1","status":"operational","year_opened":2014},
    {"city":"Mumbai","station_name":"Ghatkopar","lat":19.0864,"lng":72.9074,"line":"Line 1","status":"operational","year_opened":2014},
    {"city":"Mumbai","station_name":"Dahisar West","lat":19.2518,"lng":72.8527,"line":"Line 2A","status":"operational","year_opened":2022},
    {"city":"Mumbai","station_name":"Borivali West","lat":19.2310,"lng":72.8529,"line":"Line 2A","status":"operational","year_opened":2022},
    {"city":"Mumbai","station_name":"Goregaon West","lat":19.1602,"lng":72.8430,"line":"Line 2A","status":"operational","year_opened":2022},
    {"city":"Mumbai","station_name":"Dahisar East","lat":19.2420,"lng":72.8670,"line":"Line 7","status":"operational","year_opened":2022},
    {"city":"Mumbai","station_name":"Goregaon East","lat":19.1567,"lng":72.8701,"line":"Line 7","status":"operational","year_opened":2022},
    {"city":"Mumbai","station_name":"BKC","lat":19.0645,"lng":72.8693,"line":"Line 2B","status":"under_construction","year_opened":None},
    # ── Kolkata ───────────────────────────────────────────────────────────────
    {"city":"Kolkata","station_name":"Dakshineswar","lat":22.6447,"lng":88.3584,"line":"Blue Line","status":"operational","year_opened":2021},
    {"city":"Kolkata","station_name":"Dum Dum","lat":22.6230,"lng":88.4023,"line":"Blue Line","status":"operational","year_opened":1984},
    {"city":"Kolkata","station_name":"Esplanade","lat":22.5700,"lng":88.3525,"line":"Blue/Green","status":"operational","year_opened":1984},
    {"city":"Kolkata","station_name":"Park Street","lat":22.5530,"lng":88.3519,"line":"Blue Line","status":"operational","year_opened":1984},
    {"city":"Kolkata","station_name":"Tollygunge","lat":22.5099,"lng":88.3502,"line":"Blue Line","status":"operational","year_opened":1984},
    {"city":"Kolkata","station_name":"Howrah Maidan","lat":22.5847,"lng":88.3350,"line":"Green Line","status":"operational","year_opened":2023},
    {"city":"Kolkata","station_name":"Salt Lake Sector V","lat":22.5750,"lng":88.4305,"line":"Green Line","status":"operational","year_opened":2023},
    # ── Pune ─────────────────────────────────────────────────────────────────
    {"city":"Pune","station_name":"PCMC Bhavan","lat":18.6315,"lng":73.8058,"line":"Line 1","status":"operational","year_opened":2023},
    {"city":"Pune","station_name":"Shivajinagar","lat":18.5292,"lng":73.8396,"line":"Line 1","status":"operational","year_opened":2023},
    {"city":"Pune","station_name":"Pune Railway Station","lat":18.5290,"lng":73.8739,"line":"Line 1","status":"operational","year_opened":2023},
    {"city":"Pune","station_name":"Ramwadi","lat":18.5542,"lng":73.9196,"line":"Line 1","status":"operational","year_opened":2024},
    {"city":"Pune","station_name":"Vanaz","lat":18.5064,"lng":73.8171,"line":"Line 2","status":"operational","year_opened":2023},
    {"city":"Pune","station_name":"Civil Court","lat":18.5140,"lng":73.8576,"line":"Line 1","status":"operational","year_opened":2023},
    # ── Ahmedabad / GMRC ──────────────────────────────────────────────────────
    {"city":"Ahmedabad","station_name":"Motera Stadium","lat":23.0996,"lng":72.5988,"line":"Line 1","status":"operational","year_opened":2022},
    {"city":"Ahmedabad","station_name":"Kalupur Railway Station","lat":23.0339,"lng":72.5987,"line":"Line 1","status":"operational","year_opened":2022},
    {"city":"Ahmedabad","station_name":"Old High Court","lat":23.0334,"lng":72.5793,"line":"Line 1","status":"operational","year_opened":2022},
    {"city":"Ahmedabad","station_name":"Vastral Gam","lat":23.0100,"lng":72.6702,"line":"Line 1","status":"operational","year_opened":2022},
    {"city":"Ahmedabad","station_name":"Thaltej Gam","lat":23.0677,"lng":72.5062,"line":"Line 2","status":"operational","year_opened":2022},
    {"city":"Ahmedabad","station_name":"Gandhinagar Capital","lat":23.2156,"lng":72.6369,"line":"Line 1","status":"operational","year_opened":2024},
    # ── Kochi — KMRL ──────────────────────────────────────────────────────────
    {"city":"Kochi","station_name":"Aluva","lat":10.1078,"lng":76.3515,"line":"Line 1","status":"operational","year_opened":2017},
    {"city":"Kochi","station_name":"Edapally","lat":10.0214,"lng":76.3042,"line":"Line 1","status":"operational","year_opened":2017},
    {"city":"Kochi","station_name":"MG Road","lat":9.9312,"lng":76.2673,"line":"Line 1","status":"operational","year_opened":2017},
    {"city":"Kochi","station_name":"Vyttila","lat":9.9530,"lng":76.3082,"line":"Line 1","status":"operational","year_opened":2017},
    {"city":"Kochi","station_name":"Tripunithura","lat":9.9448,"lng":76.3458,"line":"Line 1","status":"operational","year_opened":2019},
    # ── Jaipur ────────────────────────────────────────────────────────────────
    {"city":"Jaipur","station_name":"Chandpole","lat":26.9233,"lng":75.8060,"line":"Line 1","status":"operational","year_opened":2015},
    {"city":"Jaipur","station_name":"Mansarovar","lat":26.8607,"lng":75.7535,"line":"Line 1","status":"operational","year_opened":2015},
    {"city":"Jaipur","station_name":"Civil Lines","lat":26.9174,"lng":75.7890,"line":"Line 1","status":"operational","year_opened":2015},
    # ── Lucknow ───────────────────────────────────────────────────────────────
    {"city":"Lucknow","station_name":"CCS Airport","lat":26.7636,"lng":80.8955,"line":"NS Corridor","status":"operational","year_opened":2017},
    {"city":"Lucknow","station_name":"Hazratganj","lat":26.8472,"lng":80.9462,"line":"NS Corridor","status":"operational","year_opened":2017},
    {"city":"Lucknow","station_name":"Alambagh Bus Station","lat":26.8153,"lng":80.9105,"line":"NS Corridor","status":"operational","year_opened":2017},
    # ── Nagpur ────────────────────────────────────────────────────────────────
    {"city":"Nagpur","station_name":"Sitabuldi Interchange","lat":21.1490,"lng":79.0731,"line":"Line 1/2","status":"operational","year_opened":2023},
    {"city":"Nagpur","station_name":"Kasturchand Park","lat":21.1547,"lng":79.0784,"line":"Line 1","status":"operational","year_opened":2023},
    {"city":"Nagpur","station_name":"Prajapati Nagar","lat":21.0668,"lng":79.0714,"line":"Line 1","status":"operational","year_opened":2023},
    # ── Future networks (under_construction / proposed) ───────────────────────
    {"city":"Bhopal","station_name":"AIIMS Bhopal","lat":23.1930,"lng":77.4140,"line":"Line 1","status":"under_construction","year_opened":None},
    {"city":"Indore","station_name":"Rajwada","lat":22.7196,"lng":75.8577,"line":"Line 1","status":"under_construction","year_opened":None},
    {"city":"Patna","station_name":"Patna Junction","lat":25.5941,"lng":85.1376,"line":"Line 1","status":"under_construction","year_opened":None},
    {"city":"Bhubaneswar","station_name":"Bhubaneswar Railway Station","lat":20.2706,"lng":85.8365,"line":"Line 1","status":"proposed","year_opened":None},
    {"city":"Visakhapatnam","station_name":"Steel Plant","lat":17.6930,"lng":83.2185,"line":"Line 1","status":"under_construction","year_opened":None},
    {"city":"Surat","station_name":"Surat Railway Station","lat":21.2062,"lng":72.9722,"line":"Line 1","status":"under_construction","year_opened":None},
    {"city":"Meerut","station_name":"Meerut Central (RRTS)","lat":28.9845,"lng":77.7064,"line":"RRTS Delhi-Meerut","status":"under_construction","year_opened":None},
]


# ── Main ingestion logic ───────────────────────────────────────────────────────

def load_raw_csv() -> pd.DataFrame:
    """Load raw CSV if it exists, otherwise use seed data."""
    if RAW_CSV.exists():
        log.info(f"Loading raw CSV from {RAW_CSV}")
        df = pd.read_csv(RAW_CSV)
        log.info(f"  Raw rows: {len(df)}")
        return df
    log.info("No raw CSV found — using curated seed data")
    return pd.DataFrame(SEED_STATIONS)


def validate_and_clean(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    """
    Validate each row with the Pydantic MetroStation model.
    Returns (valid_records, rejected_records).
    """
    valid, rejected = [], []

    for idx, row in df.iterrows():
        raw = row.to_dict()
        # Rename common CSV column aliases to our standard field names
        rename = {
            "Station Name": "station_name", "Station": "station_name",
            "City": "city", "Latitude": "lat", "Longitude": "lng",
            "Line": "line", "Status": "status", "Year Opened": "year_opened",
            "Year": "year_opened", "State": "state",
        }
        cleaned = {rename.get(k, k.lower().replace(" ", "_")): v for k, v in raw.items()}

        try:
            station = MetroStation(**cleaned)
            valid.append(station.model_dump())
        except ValidationError as e:
            log.warning(f"Row {idx} rejected: {e.errors()[0]['msg']} | raw={raw.get('station_name','?')}")
            rejected.append({"row": idx, "raw": raw, "error": str(e)})

    return valid, rejected


def deduplicate(records: list[dict]) -> list[dict]:
    """
    Remove duplicate station entries (same name + city + line).
    Keeps the one with the most information (non-null year_opened preferred).
    """
    seen: dict[str, dict] = {}
    for r in records:
        key = f"{r['city']}|{r['station_name'].lower()}|{r['line'].lower()}"
        existing = seen.get(key)
        if not existing:
            seen[key] = r
        elif r.get("year_opened") and not existing.get("year_opened"):
            seen[key] = r  # prefer record with known open year
    result = list(seen.values())
    log.info(f"Deduplication: {len(records)} -> {len(result)} records")
    return result


def enrich(records: list[dict]) -> list[dict]:
    """
    Add computed/derived fields beyond what the raw data provides:
      - is_interchange: True if the station serves multiple lines
      - years_since_opening: helpful for age-weighting in the scoring model
    """
    current_year = datetime.now().year
    # Count stations per (city, station_name) to detect interchanges
    name_counts: dict[str, int] = {}
    for r in records:
        key = f"{r['city']}|{r['station_name'].lower()}"
        name_counts[key] = name_counts.get(key, 0) + 1

    enriched = []
    for r in records:
        key = f"{r['city']}|{r['station_name'].lower()}"
        yr = r.get("year_opened")
        enriched.append({
            **r,
            "is_interchange": name_counts.get(key, 1) > 1,
            "years_operational": (current_year - yr) if yr and r["status"] == "operational" else None,
        })
    return enriched


def main():
    log.info("=" * 60)
    log.info("01_ingest_metro_stations.py")
    log.info("=" * 60)

    df = load_raw_csv()
    valid, rejected = validate_and_clean(df)

    log.info(f"\nValidation: {len(valid)} valid, {len(rejected)} rejected")
    if rejected:
        rej_path = ETL_DIR / "data/processed/01_rejected.json"
        with open(rej_path, "w") as f:
            json.dump(rejected, f, indent=2)
        log.info(f"Rejected rows saved to {rej_path}")

    deduped   = deduplicate(valid)
    enriched  = enrich(deduped)

    # Summary stats
    by_status = pd.DataFrame(enriched).groupby("status").size().to_dict()
    by_city   = pd.DataFrame(enriched).groupby("city").size().to_dict()
    log.info(f"\nBy status: {by_status}")
    log.info(f"Cities covered: {sorted(by_city.keys())}")

    # Write output
    out = {
        "generated_at": datetime.now(UTC).isoformat(),
        "total_stations": len(enriched),
        "by_status": by_status,
        "cities_covered": len(by_city),
        "stations": enriched,
    }
    out_path = OUTPUT_DIR / "metro_stations.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    log.info(f"\nWritten: {out_path} ({len(enriched)} stations)")
    return out_path


if __name__ == "__main__":
    main()
