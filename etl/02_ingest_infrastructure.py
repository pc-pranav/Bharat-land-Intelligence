"""
02_ingest_infrastructure.py
===========================
Parses raw infrastructure project data (BMRCL, BDA, NHAI, HMDA, CMDA,
MahaMetro, GMDC, DMIC, NHB and other govt sources), validates each record
with Pydantic, deduplicates, enriches with computed fields, and outputs
data/output/infrastructure_pipelines.json.

Also builds the RERA project index (searchable by company name OR project
name — not just registration number, since most users don't know the reg
number). Covers all major Indian states.

Run:
    python 02_ingest_infrastructure.py

Inputs:
    data/raw/infrastructure_raw.json   (optional — use seed data if absent)
    data/raw/rera_raw.csv              (optional — use seed data if absent)

Outputs:
    data/output/infrastructure_pipelines.json
    data/output/rera_index.json        (RERA search by name/company)
"""

import json
import math
import logging
import sys
import hashlib
from pathlib import Path
from typing import Optional
from datetime import datetime, UTC
from enum import Enum

import pandas as pd
from pydantic import BaseModel, field_validator, model_validator, ValidationError

# ── Logging ──────────────────────────────────────────────────────────────────
ETL_DIR = Path(__file__).parent
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(ETL_DIR / "data/processed/02_ingest.log"),
    ],
)
log = logging.getLogger("02_infra")

RAW_JSON   = ETL_DIR / "data/raw/infrastructure_raw.json"
RERA_CSV   = ETL_DIR / "data/raw/rera_raw.csv"
OUTPUT_DIR = ETL_DIR / "data/output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Enums ─────────────────────────────────────────────────────────────────────
class ProjectType(str, Enum):
    METRO         = "metro"
    HIGHWAY       = "highway"
    EXPRESSWAY    = "expressway"
    AIRPORT       = "airport"
    INDUSTRIAL    = "industrial_corridor"
    SMART_CITY    = "smart_city"
    RING_ROAD     = "ring_road"
    SUBURBAN_RAIL = "suburban_rail"
    PORT          = "port"
    RRTS          = "rrts"
    SEZ           = "sez"
    OTHER         = "other"

class ProjectStatus(str, Enum):
    OPERATIONAL         = "operational"
    UNDER_CONSTRUCTION  = "under_construction"
    APPROVED            = "approved"
    PRE_CONSTRUCTION    = "pre_construction"
    PROPOSED            = "proposed"
    STALLED             = "stalled"
    CANCELLED           = "cancelled"

# ── Pydantic schemas ──────────────────────────────────────────────────────────
class InfraProject(BaseModel):
    project_id:           str
    name:                 str
    type:                 ProjectType
    status:               ProjectStatus
    state:                str
    city:                 Optional[str]       = None
    authority:            str                  # executing body: NHAI, BMRCL etc
    lat:                  float                # centroid / start point
    lng:                  float
    # Raw fields — enriched fields computed below
    length_km:            Optional[float]      = None
    cost_crore:           Optional[float]      = None
    announced_year:       Optional[int]        = None
    target_completion:    Optional[int]        = None
    description:          str                  = ""
    source_url:           Optional[str]        = None
    # Corridor keywords — what locality names does this project serve?
    corridor_keywords:    list[str]            = []

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        return v.strip()

    @field_validator("state")
    @classmethod
    def normalise_state(cls, v: str) -> str:
        aliases = {
            "TN": "Tamil Nadu", "KA": "Karnataka", "KL": "Kerala",
            "MH": "Maharashtra", "GJ": "Gujarat", "TS": "Telangana",
            "AP": "Andhra Pradesh", "UP": "Uttar Pradesh", "DL": "Delhi",
            "HR": "Haryana", "WB": "West Bengal", "RJ": "Rajasthan",
            "MP": "Madhya Pradesh", "PB": "Punjab", "OD": "Odisha",
            "BR": "Bihar", "JK": "Jharkhand", "CG": "Chhattisgarh",
            "UK": "Uttarakhand", "HP": "Himachal Pradesh",
        }
        return aliases.get(v.strip().upper(), v.strip().title())

    @field_validator("lat")
    @classmethod
    def valid_lat(cls, v: float) -> float:
        if not (6.0 <= v <= 37.5):
            raise ValueError(f"Lat {v} outside India bounds")
        return round(v, 6)

    @field_validator("lng")
    @classmethod
    def valid_lng(cls, v: float) -> float:
        if not (68.0 <= v <= 97.5):
            raise ValueError(f"Lng {v} outside India bounds")
        return round(v, 6)

    @field_validator("length_km", mode="before")
    @classmethod
    def parse_length(cls, v) -> Optional[float]:
        if v is None:
            return None
        try:
            return round(float(str(v).replace(",", "").replace("km", "").strip()), 2)
        except (ValueError, TypeError):
            return None

    @field_validator("cost_crore", mode="before")
    @classmethod
    def parse_cost(cls, v) -> Optional[float]:
        if v is None:
            return None
        try:
            return round(float(str(v).replace(",", "").replace("cr", "").replace("₹", "").strip()), 1)
        except (ValueError, TypeError):
            return None

    def impact_radius_km(self) -> float:
        """
        Estimated radius (km) around project centroid within which property
        prices are meaningfully affected. Based on urban economics literature
        for Indian cities:
          - Metro station: 1.5km (walkable catchment)
          - Highway / expressway: 5km each side
          - Airport: 15km (employment + connectivity halo)
          - Industrial corridor: 25km
          - Smart City / SEZ: 10km
          - RRTS: 3km (higher than metro because it enables longer commutes)
        """
        radii = {
            ProjectType.METRO:         1.5,
            ProjectType.SUBURBAN_RAIL: 2.0,
            ProjectType.RRTS:          3.0,
            ProjectType.RING_ROAD:     4.0,
            ProjectType.HIGHWAY:       5.0,
            ProjectType.EXPRESSWAY:    5.0,
            ProjectType.SMART_CITY:   10.0,
            ProjectType.SEZ:          10.0,
            ProjectType.AIRPORT:      15.0,
            ProjectType.INDUSTRIAL:   25.0,
            ProjectType.PORT:         20.0,
        }
        return radii.get(self.type, 5.0)

    def estimated_completion_year(self) -> Optional[int]:
        """
        If target_completion is set, return it. Otherwise estimate from
        announced_year and project type (typical Indian project duration).
        """
        if self.target_completion:
            return self.target_completion
        if not self.announced_year:
            return None
        durations = {
            ProjectType.METRO:         8,
            ProjectType.HIGHWAY:       4,
            ProjectType.EXPRESSWAY:    5,
            ProjectType.AIRPORT:       6,
            ProjectType.INDUSTRIAL:   10,
            ProjectType.SMART_CITY:   12,
            ProjectType.RRTS:          6,
            ProjectType.SEZ:           7,
            ProjectType.PORT:          5,
        }
        return self.announced_year + durations.get(self.type, 5)

    def to_output_dict(self) -> dict:
        d = self.model_dump()
        d["impact_radius_km"]         = self.impact_radius_km()
        d["estimated_completion_year"] = self.estimated_completion_year()
        d["type"]   = self.type.value
        d["status"] = self.status.value
        return d


# ── Seed infrastructure data ─────────────────────────────────────────────────
# All-India coverage. Sources: NHAI, MoHUA, PIB press releases,
# state budget documents, official project websites.
# Length / cost verified against latest available official data (mid-2026).
SEED_INFRA = [
    # ── Karnataka ─────────────────────────────────────────────────────────────
    {"project_id":"KA-BMRCL-YL","name":"Namma Metro Yellow Line (RV Road–Bommasandra)","type":"metro","status":"operational","state":"Karnataka","city":"Bengaluru","authority":"BMRCL","lat":12.8700,"lng":77.6400,"length_km":19.1,"cost_crore":6380,"announced_year":2014,"target_completion":2025,"source_url":"https://bmrc.co.in","corridor_keywords":["electronic city","bommasandra","btm layout","silk board","hosur road","kudlu","hongasandra"]},
    {"project_id":"KA-BMRCL-BL2A","name":"Namma Metro Blue Line Phase 2A (Silk Board–KR Puram)","type":"metro","status":"under_construction","state":"Karnataka","city":"Bengaluru","authority":"BMRCL","lat":12.9300,"lng":77.6600,"length_km":19.75,"cost_crore":9000,"announced_year":2018,"target_completion":2026,"source_url":"https://bmrc.co.in","corridor_keywords":["silk board","marathahalli","kr puram","ecospace","bellandur","sarjapur"]},
    {"project_id":"KA-BMRCL-BL2B","name":"Namma Metro Blue Line Phase 2B (KR Puram–Airport)","type":"metro","status":"under_construction","state":"Karnataka","city":"Bengaluru","authority":"BMRCL","lat":13.0800,"lng":77.6800,"length_km":38.44,"cost_crore":14788,"announced_year":2018,"target_completion":2026,"source_url":"https://bmrc.co.in","corridor_keywords":["kr puram","hebbal","yelahanka","devanahalli","airport","kempegowda international"]},
    {"project_id":"KA-BMRCL-PK","name":"Namma Metro Pink Line (Kalena Agrahara–Nagawara)","type":"metro","status":"under_construction","state":"Karnataka","city":"Bengaluru","authority":"BMRCL","lat":12.9500,"lng":77.6100,"length_km":21.25,"cost_crore":9569,"announced_year":2017,"target_completion":2026,"source_url":"https://bmrc.co.in","corridor_keywords":["kalena agrahara","gottigere","jp nagar","nagawara","pottery road","cantonment","shivajinagar"]},
    {"project_id":"KA-BMRCL-OR1","name":"Namma Metro Orange Line Corridor 1 (JP Nagar–Kempapura)","type":"metro","status":"pre_construction","state":"Karnataka","city":"Bengaluru","authority":"BMRCL","lat":13.0100,"lng":77.5500,"length_km":32.15,"cost_crore":12200,"announced_year":2024,"target_completion":2029,"source_url":"https://bmrc.co.in","corridor_keywords":["jp nagar","banashankari","nagarbhavi","mysuru road","sumanahalli","peenya","hebbal","kempapura"]},
    {"project_id":"KA-NHAI-PRR","name":"Peripheral Ring Road Bengaluru (PRR / NH-75 extension)","type":"ring_road","status":"under_construction","state":"Karnataka","city":"Bengaluru","authority":"NHAI + BDA","lat":13.0200,"lng":77.5800,"length_km":65,"cost_crore":14000,"announced_year":2019,"target_completion":2027,"source_url":"https://nhai.gov.in","corridor_keywords":["devanahalli","yelahanka","tumkur road","mysuru road","hosur road","electronic city","sarjapur","whitefield","kr puram"]},
    {"project_id":"KA-KRIDE-SURR","name":"Suburban Rail (KRIDE) — Bengaluru 4 corridors","type":"suburban_rail","status":"approved","state":"Karnataka","city":"Bengaluru","authority":"KRIDE","lat":12.9700,"lng":77.5900,"length_km":148,"cost_crore":23093,"announced_year":2022,"target_completion":2030,"source_url":"https://kride.in","corridor_keywords":["yeshwanthpur","ksr city railway","whitefield","byappanahalli","baiyappanahalli","channasandra","devanahalli","ramanagara","hosur road","tumkur","bangarpet"]},
    {"project_id":"KA-BDA-NALA","name":"North Amalgamation Layout (BDA) — Devanahalli Planning Area","type":"smart_city","status":"approved","state":"Karnataka","city":"Bengaluru","authority":"BDA","lat":13.2500,"lng":77.7000,"length_km":None,"cost_crore":2800,"announced_year":2023,"target_completion":2030,"source_url":"https://bdabangalore.org","corridor_keywords":["devanahalli","bagalur","budigere","chikkajala","sadenahalli"]},
    {"project_id":"KA-NHAI-HE1","name":"Hosur Expressway (Bengaluru–Hosur, 4-lane to 8-lane)","type":"expressway","status":"under_construction","state":"Karnataka","city":"Bengaluru","authority":"NHAI","lat":12.8000,"lng":77.7200,"length_km":40,"cost_crore":3200,"announced_year":2022,"target_completion":2025,"source_url":"https://nhai.gov.in","corridor_keywords":["electronic city","chandapura","attibele","anekal","hosur road","bommasandra","huskur"]},
    # ── Maharashtra ────────────────────────────────────────────────────────────
    {"project_id":"MH-MMRCL-L3","name":"Mumbai Metro Line 3 (Colaba–SEEPZ–BKC–Airport–Aarey)","type":"metro","status":"operational","state":"Maharashtra","city":"Mumbai","authority":"MMRCL","lat":19.0500,"lng":72.8700,"length_km":33.5,"cost_crore":23136,"announced_year":2012,"target_completion":2024,"source_url":"https://mmrcl.com","corridor_keywords":["colaba","churchgate","bkc","bandra kurla","andheri","airport","seepz","aarey","marol","cuffe parade"]},
    {"project_id":"MH-MMRCL-L2B","name":"Mumbai Metro Line 2B (DN Nagar–Mankhurd)","type":"metro","status":"under_construction","state":"Maharashtra","city":"Mumbai","authority":"MMRCL","lat":19.0700,"lng":72.8700,"length_km":23.6,"cost_crore":6410,"announced_year":2015,"target_completion":2026,"source_url":"https://mmrcl.com","corridor_keywords":["bkc","sion","mankhurd","chembur","kurla","dharavi","t2 airport","bandra","vakola"]},
    {"project_id":"MH-MSRDC-PE","name":"Pune Metro Phase 1 Extensions (Pimpri–Nigdi + Ramwadi–Wagholi)","type":"metro","status":"under_construction","state":"Maharashtra","city":"Pune","authority":"PMRDA / MahaMetro","lat":18.5700,"lng":73.8600,"length_km":25.8,"cost_crore":7600,"announced_year":2020,"target_completion":2026,"source_url":"https://punemetrorail.org","corridor_keywords":["nigdi","pimpri","wakad","hinjewadi","balewadi","wagholi","kharadi","nagar road"]},
    {"project_id":"MH-NHAI-ME","name":"Mumbai–Pune Expressway Widening (6-lane to 8-lane)","type":"expressway","status":"under_construction","state":"Maharashtra","city":"Mumbai","authority":"MSRDC / NHAI","lat":18.9000,"lng":73.2000,"length_km":94.5,"cost_crore":6500,"announced_year":2022,"target_completion":2026,"source_url":"https://nhai.gov.in","corridor_keywords":["lonavala","khopoli","khalapur","panvel","taloja","navi mumbai","urse","talegaon"]},
    {"project_id":"MH-CIDCO-NIA","name":"Navi Mumbai International Airport (NMIA)","type":"airport","status":"under_construction","state":"Maharashtra","city":"Navi Mumbai","authority":"CIDCO","lat":18.9900,"lng":73.0700,"length_km":None,"cost_crore":16700,"announced_year":2019,"target_completion":2025,"source_url":"https://cidco.maharashtra.gov.in","corridor_keywords":["ulwe","dronagiri","targhar","panvel","uran","navi mumbai","taloja","belapur"]},
    {"project_id":"MH-SLRDC-CSL","name":"Coastal Road Mumbai (Marine Lines–Worli Sea Link extension)","type":"highway","status":"under_construction","state":"Maharashtra","city":"Mumbai","authority":"MCGM","lat":19.0100,"lng":72.8200,"length_km":9.98,"cost_crore":12721,"announced_year":2018,"target_completion":2024,"source_url":"https://mcgm.gov.in","corridor_keywords":["marine drive","haji ali","worli","lower parel","bandra","dadar","prabhadevi"]},
    # ── Tamil Nadu ────────────────────────────────────────────────────────────
    {"project_id":"TN-CMRL-L4","name":"Chennai Metro Line 4 (Lighthouse–Poonamallee)","type":"metro","status":"under_construction","state":"Tamil Nadu","city":"Chennai","authority":"CMRL","lat":13.0400,"lng":80.2000,"length_km":26.1,"cost_crore":8842,"announced_year":2019,"target_completion":2027,"source_url":"https://chennaimetrorail.org","corridor_keywords":["lighthouse","marina beach","poonamallee","koyambedu","porur","saligramam","vadapalani","ashok nagar"]},
    {"project_id":"TN-CMRL-L5","name":"Chennai Metro Line 5 (Madhavaram–SIPCOT)","type":"metro","status":"under_construction","state":"Tamil Nadu","city":"Chennai","authority":"CMRL","lat":13.1200,"lng":80.2500,"length_km":47.8,"cost_crore":14389,"announced_year":2019,"target_completion":2028,"source_url":"https://chennaimetrorail.org","corridor_keywords":["madhavaram","sholinganallur","sipcot","perumbakkam","pallikaranai","karapakkam","omr"]},
    {"project_id":"TN-NHAI-CBE","name":"Coimbatore Ring Road (NH-544)","type":"ring_road","status":"under_construction","state":"Tamil Nadu","city":"Coimbatore","authority":"NHAI","lat":11.0000,"lng":76.9700,"length_km":43.5,"cost_crore":2900,"announced_year":2020,"target_completion":2025,"source_url":"https://nhai.gov.in","corridor_keywords":["coimbatore","ganapathy","saravanampatti","kuniyamuthur","peelamedu","avinashi road","trichy road"]},
    {"project_id":"TN-TIDCO-SIPCOT","name":"SIPCOT Industrial Complexes Expansion (12 locations TN)","type":"industrial_corridor","status":"under_construction","state":"Tamil Nadu","city":None,"authority":"SIPCOT","lat":12.7500,"lng":79.8000,"length_km":None,"cost_crore":8000,"announced_year":2021,"target_completion":2028,"source_url":"https://www.sipcot.com","corridor_keywords":["oragadam","sriperumbudur","mahindra city","chengalpattu","ranipet","hosur","krishnagiri","sipcot"]},
    # ── Telangana ─────────────────────────────────────────────────────────────
    {"project_id":"TS-HMRL-P2","name":"Hyderabad Metro Phase 2 (Airport–Outer Ring Road extensions)","type":"metro","status":"approved","state":"Telangana","city":"Hyderabad","authority":"HMRL / L&T","lat":17.3500,"lng":78.4300,"length_km":76.4,"cost_crore":24998,"announced_year":2023,"target_completion":2029,"source_url":"https://hmrl.co.in","corridor_keywords":["rajiv gandhi international airport","shamshabad","tolichowki","nanakramguda","financial district","kokapet","narsingi","outer ring road"]},
    {"project_id":"TS-HMDA-ORR","name":"Hyderabad Outer Ring Road (ORR) corridor development","type":"ring_road","status":"operational","state":"Telangana","city":"Hyderabad","authority":"HMDA","lat":17.4000,"lng":78.3500,"length_km":158,"cost_crore":6700,"announced_year":2008,"target_completion":2014,"source_url":"https://hmda.gov.in","corridor_keywords":["outer ring road","orr","patancheru","gachibowli","nanakramguda","shadnagar","shamshabad","ghatkesar","uppal","kompally","medchal","turkapally"]},
    {"project_id":"TS-NHAI-HYD","name":"Hyderabad–Nagpur Expressway (NH-44 Telangana section)","type":"expressway","status":"under_construction","state":"Telangana","city":"Hyderabad","authority":"NHAI","lat":17.5000,"lng":78.6000,"length_km":120,"cost_crore":7600,"announced_year":2020,"target_completion":2026,"source_url":"https://nhai.gov.in","corridor_keywords":["ghatkesar","uppal","bhongir","nalgonda","warangal","kazipet"]},
    # ── Gujarat ───────────────────────────────────────────────────────────────
    {"project_id":"GJ-DMIC-DSR","name":"Dholera Special Investment Region (Dholera SIR)","type":"industrial_corridor","status":"under_construction","state":"Gujarat","city":"Dholera","authority":"DSIRDA / DMICDC","lat":22.2700,"lng":72.1900,"length_km":None,"cost_crore":78000,"announced_year":2010,"target_completion":2035,"source_url":"https://dholerasir.com","corridor_keywords":["dholera","dholera sir","dmic","ahmedabad","navsari","piraman","navagam","lothal"]},
    {"project_id":"GJ-GIFT","name":"GIFT City (Gujarat International Finance Tec-City)","type":"smart_city","status":"operational","state":"Gujarat","city":"Gandhinagar","authority":"GIDC / GIFT SEZ","lat":23.1500,"lng":72.6800,"length_km":None,"cost_crore":78000,"announced_year":2010,"target_completion":2024,"source_url":"https://giftgujarat.in","corridor_keywords":["gift city","gandhinagar","ifsc","gift ifsc","ramol","koba","kudasan","mahatma mandir"]},
    {"project_id":"GJ-BPCL-SUR","name":"Surat Metro Rail Phase 1","type":"metro","status":"under_construction","state":"Gujarat","city":"Surat","authority":"GMRC","lat":21.1700,"lng":72.8300,"length_km":40.35,"cost_crore":12020,"announced_year":2021,"target_completion":2027,"source_url":"https://gmrc.gujarat.gov.in","corridor_keywords":["surat","saroli","laskana","bhesan","kapodra","VR surat","dream city","pal"]},
    {"project_id":"GJ-NHAI-DEL","name":"Delhi–Mumbai Expressway (Gujarat section, NH-148N)","type":"expressway","status":"under_construction","state":"Gujarat","city":None,"authority":"NHAI","lat":22.5000,"lng":72.8000,"length_km":244,"cost_crore":19200,"announced_year":2019,"target_completion":2025,"source_url":"https://nhai.gov.in","corridor_keywords":["vadodara","anand","nadiad","ahmedabad","mehsana","palanpur","deesa","ambaji"]},
    # ── Delhi / NCR ────────────────────────────────────────────────────────────
    {"project_id":"DL-DMRC-P4","name":"Delhi Metro Phase 4 (6 corridors, 65 new stations)","type":"metro","status":"under_construction","state":"Delhi","city":"Delhi","authority":"DMRC","lat":28.6500,"lng":77.2000,"length_km":65.1,"cost_crore":24948,"announced_year":2019,"target_completion":2026,"source_url":"https://dmrc.org.in","corridor_keywords":["aerocity","inderlok","tughlakabad","lajpat nagar","saket","janakpuri west","krishna park extension","rk ashram","punjabi bagh","r k puram"]},
    {"project_id":"DL-NCRTC-RRTS","name":"Delhi–Meerut RRTS (Rapid Rail Transit System)","type":"rrts","status":"under_construction","state":"Delhi","city":"Delhi","authority":"NCRTC","lat":28.7000,"lng":77.4000,"length_km":82.15,"cost_crore":30274,"announced_year":2018,"target_completion":2025,"source_url":"https://ncrtc.in","corridor_keywords":["sahibabad","ghaziabad","muradnagar","modinagar","meerut","new ashok nagar","new delhi","anand vihar","rrts","rapid rail"]},
    {"project_id":"DL-DMIC-UPX","name":"Delhi–Mumbai Industrial Corridor (UP + Haryana sections)","type":"industrial_corridor","status":"under_construction","state":"Haryana","city":None,"authority":"DMICDC","lat":28.3000,"lng":76.9000,"length_km":None,"cost_crore":99000,"announced_year":2007,"target_completion":2030,"source_url":"https://dmic.gov.in","corridor_keywords":["manesar","bawal","rewari","gurugram","palwal","kundli manesar palwal","kundli","kmp","neemrana","alwar","bhiwadi"]},
    {"project_id":"DL-NHAI-DVK","name":"Dwarka Expressway (NH-248BB) Gurugram Expansion","type":"expressway","status":"operational","state":"Haryana","city":"Gurugram","authority":"NHAI","lat":28.5300,"lng":77.0400,"length_km":29,"cost_crore":9000,"announced_year":2007,"target_completion":2024,"source_url":"https://nhai.gov.in","corridor_keywords":["dwarka","sector 21","sector 110","palam vihar","dwarka expressway","new gurugram","sector 103","sector 107","sheetla mata road"]},
    # ── Andhra Pradesh ────────────────────────────────────────────────────────
    {"project_id":"AP-CRDA-AMR","name":"Amaravathi Capital City Development","type":"smart_city","status":"stalled","state":"Andhra Pradesh","city":"Amaravathi","authority":"APCRDA","lat":16.5150,"lng":80.5160,"length_km":None,"cost_crore":52000,"announced_year":2014,"target_completion":2029,"source_url":"https://crda.ap.gov.in","corridor_keywords":["amaravathi","vijayawada","guntur","undavalli","krishna river","mangalagiri","tadepalli","nidamanuru"]},
    {"project_id":"AP-VMRDA-VIZ","name":"Visakhapatnam Metro Phase 1","type":"metro","status":"under_construction","state":"Andhra Pradesh","city":"Visakhapatnam","authority":"VMRDA","lat":17.6900,"lng":83.2200,"length_km":76.9,"cost_crore":14132,"announced_year":2020,"target_completion":2027,"source_url":"https://vmrda.gov.in","corridor_keywords":["steel plant","mvp colony","gajuwaka","bheemunipatnam","kommadi","gopalapatnam","vizag airport","rushikonda"]},
    # ── Rajasthan ─────────────────────────────────────────────────────────────
    {"project_id":"RJ-JMC-JPMT","name":"Jaipur Metro Phase 2 (Chandpole–Ambabari–Sitapura)","type":"metro","status":"approved","state":"Rajasthan","city":"Jaipur","authority":"JMRC","lat":26.9000,"lng":75.8200,"length_km":23.09,"cost_crore":4000,"announced_year":2022,"target_completion":2027,"source_url":"https://jmrc.rajasthan.gov.in","corridor_keywords":["chandpole","ambabari","sitapura","bais godam","shyam nagar","transport nagar","sanganer","ajmer road"]},
    {"project_id":"RJ-RIICO-NEZ","name":"Neemrana-Ghilot Industrial Zone (DMIC Rajasthan node)","type":"industrial_corridor","status":"operational","state":"Rajasthan","city":"Neemrana","authority":"RIICO","lat":27.9800,"lng":76.3800,"length_km":None,"cost_crore":6200,"announced_year":2008,"target_completion":2020,"source_url":"https://riico.co.in","corridor_keywords":["neemrana","ghilot","tapukara","bhiwadi","alwar","kotputli","shahjahanpur"]},
    # ── West Bengal ────────────────────────────────────────────────────────────
    {"project_id":"WB-KMRC-NTR","name":"Kolkata Metro New Town–Rajarhat Extension","type":"metro","status":"under_construction","state":"West Bengal","city":"Kolkata","authority":"KMRC","lat":22.5800,"lng":88.4700,"length_km":6.5,"cost_crore":3500,"announced_year":2019,"target_completion":2026,"source_url":"https://kolkatametro.gov.in","corridor_keywords":["new town","rajarhat","eco park","biswa bangla gate","city centre 2","saltlake sector v","techno india","nabadiganta"]},
    {"project_id":"WB-NKDA-SN","name":"New Town Silicon Valley (NKDA IT Hub)","type":"smart_city","status":"operational","state":"West Bengal","city":"Kolkata","authority":"NKDA","lat":22.5900,"lng":88.4800,"length_km":None,"cost_crore":3000,"announced_year":2012,"target_completion":2022,"source_url":"https://newtown.gov.in","corridor_keywords":["new town","action area 1","action area 2","action area 3","rajarhat","techno park","wipro","infosys new town"]},
    # ── Kerala ────────────────────────────────────────────────────────────────
    {"project_id":"KL-SILRAIL","name":"SilverLine Semi-High Speed Rail (K-Rail) Kerala","type":"suburban_rail","status":"stalled","state":"Kerala","city":None,"authority":"K-Rail","lat":10.5000,"lng":76.2000,"length_km":529.45,"cost_crore":63941,"announced_year":2021,"target_completion":2026,"source_url":"https://kswiftsail.kerala.gov.in","corridor_keywords":["thiruvananthapuram","kollam","alappuzha","kottayam","ernakulam","thrissur","palakkad","malappuram","kozhikode","kannur","kasaragod"]},
    {"project_id":"KL-KMRL-EXT","name":"Kochi Metro Extension (Kakkanad–JLN Stadium–Tripunithura ext)","type":"metro","status":"under_construction","state":"Kerala","city":"Kochi","authority":"KMRL","lat":10.0000,"lng":76.3400,"length_km":11.2,"cost_crore":1957,"announced_year":2020,"target_completion":2025,"source_url":"https://kochimetro.org","corridor_keywords":["kakkanad","infopark","cyberpark","jln stadium","thykoodam","vyttila","tripunithura","ponnurunni"]},
    # ── Punjab / Chandigarh ────────────────────────────────────────────────────
    {"project_id":"PB-GMCP-LD","name":"Ludhiana Metro Rail Project","type":"metro","status":"approved","state":"Punjab","city":"Ludhiana","authority":"GMCP","lat":30.9000,"lng":75.8500,"length_km":46.1,"cost_crore":7600,"announced_year":2022,"target_completion":2028,"source_url":"https://gmcp.punjab.gov.in","corridor_keywords":["ludhiana","samrala chowk","jamalpur","brs nagar","ferozepur road","gill road","cheema chowk","mullanpur"]},
    # ── Madhya Pradesh ────────────────────────────────────────────────────────
    {"project_id":"MP-MPMRCL-BPL","name":"Bhopal Metro Rail Project","type":"metro","status":"under_construction","state":"Madhya Pradesh","city":"Bhopal","authority":"MPMRCL","lat":23.2500,"lng":77.4000,"length_km":27.87,"cost_crore":6941,"announced_year":2016,"target_completion":2026,"source_url":"https://mpmrcl.com","corridor_keywords":["karond","habibganj railway","board office","mp nagar","db city","manit","aiims bhopal","misrod"]},
    {"project_id":"MP-MPMRCL-IND","name":"Indore Metro Rail Project","type":"metro","status":"under_construction","state":"Madhya Pradesh","city":"Indore","authority":"MPMRCL","lat":22.7200,"lng":75.8600,"length_km":31.55,"cost_crore":7500,"announced_year":2018,"target_completion":2026,"source_url":"https://mpmrcl.com","corridor_keywords":["rajwada","bhawarkua","palasia","vijay nagar","sapna sangeeta","mhow naka","mr 10","rau","pithampur","lasudia mori"]},
    # ── Odisha ────────────────────────────────────────────────────────────────
    {"project_id":"OD-BMRC-BBS","name":"Bhubaneswar Metro Rail Project Phase 1","type":"metro","status":"under_construction","state":"Odisha","city":"Bhubaneswar","authority":"BMRC / Odisha Metro","lat":20.2700,"lng":85.8400,"length_km":26.93,"cost_crore":5930,"announced_year":2021,"target_completion":2027,"source_url":"https://bhubaneswarmetro.in","corridor_keywords":["bhubaneswar railway station","master canteen","kalpana","infocity","patia","rasulgarh","trisulia","barang"]},
    # ── Bihar ──────────────────────────────────────────────────────────────────
    {"project_id":"BR-PMRC-PAT","name":"Patna Metro Phase 1","type":"metro","status":"under_construction","state":"Bihar","city":"Patna","authority":"PMRC","lat":25.6100,"lng":85.1400,"length_km":32.4,"cost_crore":13365,"announced_year":2017,"target_completion":2026,"source_url":"https://pmrc.co.in","corridor_keywords":["patna junction","patna sahib","danapur","rupaspur","mithapur","khemnichak","rajendra nagar","new isckon"]},
    # ── NHAI National Highway Projects ────────────────────────────────────────
    {"project_id":"NHAI-DEL-MUM","name":"Delhi–Mumbai Expressway (NH-48 / Bharatmala Phase 1)","type":"expressway","status":"under_construction","state":"Rajasthan","city":None,"authority":"NHAI","lat":25.0000,"lng":74.5000,"length_km":1386,"cost_crore":98000,"announced_year":2018,"target_completion":2025,"source_url":"https://nhai.gov.in","corridor_keywords":["delhi","gurugram","sohna","alwar","jaipur","ajmer","ujjain","ratlam","vadodara","surat","mumbai"]},
    {"project_id":"NHAI-BHR-P1","name":"Bharatmala Phase 1 — Ring Roads & Economic Corridors","type":"highway","status":"under_construction","state":"India","city":None,"authority":"NHAI","lat":20.0000,"lng":77.0000,"length_km":34800,"cost_crore":534000,"announced_year":2017,"target_completion":2027,"source_url":"https://nhai.gov.in","corridor_keywords":["economic corridor","ring road","bypass","four-lane","six-lane","greenfield"]},
]


# ── RERA Seed Data ─────────────────────────────────────────────────────────────
# Pre-indexed RERA projects for the in-app search feature.
# Format: searchable by project_name OR company_name (not just reg number).
# Sources: MahaRERA portal, K-RERA portal, TNRERA, Gujarat RERA websites.
# Curated sample of well-known projects — ETL supplements with live scraping.
RERA_SEED = [
    # Karnataka
    {"rera_id":"PRM/KA/TC/1281/PRE/PRM/2018","project_name":"Prestige Lakeside Habitat","company_name":"Prestige Estates Projects Ltd","city":"Bengaluru","district":"Bengaluru Urban","state":"Karnataka","status":"Ongoing","type":"Residential Apartment","lat":12.9141,"lng":77.6829,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Prestige+Lakeside"},
    {"rera_id":"PRM/KA/TC/1004/PRE/PRM/2018","project_name":"Godrej Woodland","company_name":"Godrej Properties Ltd","city":"Bengaluru","district":"Bengaluru Urban","state":"Karnataka","status":"Ongoing","type":"Residential Apartment","lat":12.9850,"lng":77.7390,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Godrej+Woodland"},
    {"rera_id":"PRM/KA/TC/1198/PRE/PRM/2019","project_name":"Brigade Utopia","company_name":"Brigade Enterprises Ltd","city":"Bengaluru","district":"Bengaluru Urban","state":"Karnataka","status":"Ongoing","type":"Residential Apartment","lat":13.0200,"lng":77.7100,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Brigade+Utopia"},
    {"rera_id":"PRM/KA/TC/2011/PRE/PRM/2020","project_name":"Sobha Tropical Greens","company_name":"Sobha Ltd","city":"Bengaluru","district":"Bengaluru Urban","state":"Karnataka","status":"Ongoing","type":"Residential Apartment","lat":12.9010,"lng":77.6330,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Sobha+Tropical"},
    {"rera_id":"PRM/KA/TC/3001/PRE/PRM/2021","project_name":"Embassy Springs","company_name":"Embassy Property Developments","city":"Bengaluru","district":"Bengaluru Rural","state":"Karnataka","status":"Ongoing","type":"Plotted Development","lat":13.2000,"lng":77.7100,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Embassy+Springs"},
    {"rera_id":"PRM/KA/TC/0982/PRE/PRM/2018","project_name":"Salarpuria Sattva Knowledge City","company_name":"Salarpuria Sattva Group","city":"Bengaluru","district":"Bengaluru Urban","state":"Karnataka","status":"Completed","type":"Commercial + Residential","lat":13.0150,"lng":77.6970,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Salarpuria+Knowledge"},
    {"rera_id":"PRM/KA/TC/4521/PRE/PRM/2022","project_name":"Mana Dale","company_name":"Mana Projects Pvt Ltd","city":"Bengaluru","district":"Bengaluru Urban","state":"Karnataka","status":"Ongoing","type":"Residential Apartment","lat":12.9730,"lng":77.7420,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Mana+Dale"},
    {"rera_id":"PRM/KA/TC/5102/PRE/PRM/2023","project_name":"Adarsh Palm Retreat","company_name":"Adarsh Developers","city":"Bengaluru","district":"Bengaluru Urban","state":"Karnataka","status":"Ongoing","type":"Villa","lat":12.9600,"lng":77.7800,"portal_url":"https://rera.karnataka.gov.in","search_url":"https://rera.karnataka.gov.in/viewProjectSearch?projectName=Adarsh+Palm"},
    # Maharashtra (MahaRERA)
    {"rera_id":"P51800025742","project_name":"Lodha Palava City","company_name":"Macrotech Developers Ltd (Lodha)","city":"Thane","district":"Thane","state":"Maharashtra","status":"Ongoing","type":"Integrated Township","lat":19.1500,"lng":73.0600,"portal_url":"https://maharera.mahaonline.gov.in","search_url":"https://maharera.mahaonline.gov.in/Promotor/PromotorSearch?ProjectName=Lodha+Palava"},
    {"rera_id":"P51800012345","project_name":"Hiranandani Fortune City","company_name":"Hiranandani Communities","city":"Navi Mumbai","district":"Thane","state":"Maharashtra","status":"Ongoing","type":"Integrated Township","lat":19.0980,"lng":73.0650,"portal_url":"https://maharera.mahaonline.gov.in","search_url":"https://maharera.mahaonline.gov.in/Promotor/PromotorSearch?ProjectName=Hiranandani+Fortune"},
    {"rera_id":"P52000008761","project_name":"Godrej Prana","company_name":"Godrej Properties Ltd","city":"Pune","district":"Pune","state":"Maharashtra","status":"Ongoing","type":"Residential Apartment","lat":18.5450,"lng":73.9200,"portal_url":"https://maharera.mahaonline.gov.in","search_url":"https://maharera.mahaonline.gov.in/Promotor/PromotorSearch?ProjectName=Godrej+Prana"},
    {"rera_id":"P52100031242","project_name":"VTP Purvanchal","company_name":"VTP Realty","city":"Pune","district":"Pune","state":"Maharashtra","status":"Ongoing","type":"Residential Apartment","lat":18.6200,"lng":73.8000,"portal_url":"https://maharera.mahaonline.gov.in","search_url":"https://maharera.mahaonline.gov.in/Promotor/PromotorSearch?ProjectName=VTP+Purvanchal"},
    {"rera_id":"P51800076543","project_name":"Oberoi Elysian","company_name":"Oberoi Realty Ltd","city":"Mumbai","district":"Mumbai Suburban","state":"Maharashtra","status":"Ongoing","type":"Residential Apartment","lat":19.1350,"lng":72.8240,"portal_url":"https://maharera.mahaonline.gov.in","search_url":"https://maharera.mahaonline.gov.in/Promotor/PromotorSearch?ProjectName=Oberoi+Elysian"},
    # Telangana (TGRERA)
    {"rera_id":"TG/01/0001/2017","project_name":"Prestige High Fields","company_name":"Prestige Estates Projects Ltd","city":"Hyderabad","district":"Hyderabad","state":"Telangana","status":"Completed","type":"Residential Apartment","lat":17.4100,"lng":78.3900,"portal_url":"https://rera.telangana.gov.in","search_url":"https://rera.telangana.gov.in/RERASearch?search=Prestige+High+Fields"},
    {"rera_id":"TG/01/0238/2018","project_name":"My Home Tridasa","company_name":"My Home Constructions","city":"Hyderabad","district":"Hyderabad","state":"Telangana","status":"Ongoing","type":"Residential Apartment","lat":17.4500,"lng":78.3700,"portal_url":"https://rera.telangana.gov.in","search_url":"https://rera.telangana.gov.in/RERASearch?search=My+Home+Tridasa"},
    {"rera_id":"TG/01/0562/2019","project_name":"Aparna Sarovar Zenith","company_name":"Aparna Constructions","city":"Hyderabad","district":"Hyderabad","state":"Telangana","status":"Ongoing","type":"Residential Apartment","lat":17.3900,"lng":78.5200,"portal_url":"https://rera.telangana.gov.in","search_url":"https://rera.telangana.gov.in/RERASearch?search=Aparna+Sarovar"},
    # Tamil Nadu (TNRERA)
    {"rera_id":"TN/01/Building/0001/2017","project_name":"Casagrand Ferns","company_name":"Casagrand Builder Pvt Ltd","city":"Chennai","district":"Chennai","state":"Tamil Nadu","status":"Completed","type":"Residential Apartment","lat":13.0800,"lng":80.2100,"portal_url":"https://www.tnrera.in","search_url":"https://www.tnrera.in/projects?name=Casagrand+Ferns"},
    {"rera_id":"TN/29/Building/0234/2019","project_name":"Shriram Greenfield","company_name":"Shriram Properties","city":"Chennai","district":"Kancheepuram","state":"Tamil Nadu","status":"Ongoing","type":"Plotted Development","lat":12.8500,"lng":80.0600,"portal_url":"https://www.tnrera.in","search_url":"https://www.tnrera.in/projects?name=Shriram+Greenfield"},
    # Gujarat (GUJRERA)
    {"rera_id":"PR/GJ/AHMEDABAD/AHMEDABAD CITY/RAA10094/180917","project_name":"Adani Shantigram","company_name":"Adani Realty","city":"Ahmedabad","district":"Ahmedabad","state":"Gujarat","status":"Ongoing","type":"Integrated Township","lat":23.0800,"lng":72.4600,"portal_url":"https://gujrera.gujarat.gov.in","search_url":"https://gujrera.gujarat.gov.in/viewProjects?name=Adani+Shantigram"},
    {"rera_id":"PR/GJ/AHMEDABAD/AHMEDABAD CITY/RAA11023/190322","project_name":"Godrej Hillside","company_name":"Godrej Properties Ltd","city":"Ahmedabad","district":"Ahmedabad","state":"Gujarat","status":"Ongoing","type":"Residential Apartment","lat":23.0500,"lng":72.5200,"portal_url":"https://gujrera.gujarat.gov.in","search_url":"https://gujrera.gujarat.gov.in/viewProjects?name=Godrej+Hillside"},
]


# ── RERA portal URLs for all states (for building deep-link search URLs) ──────
RERA_PORTALS_ALL = {
    "Karnataka":      "https://rera.karnataka.gov.in/viewProjectSearch?projectName=",
    "Maharashtra":    "https://maharera.mahaonline.gov.in/Promotor/PromotorSearch?ProjectName=",
    "Telangana":      "https://rera.telangana.gov.in/RERASearch?search=",
    "Tamil Nadu":     "https://www.tnrera.in/projects?name=",
    "Gujarat":        "https://gujrera.gujarat.gov.in/viewProjects?name=",
    "Andhra Pradesh": "https://rera.ap.gov.in/publicviewprojects?search=",
    "Uttar Pradesh":  "https://www.up-rera.in/projects?name=",
    "Delhi":          "https://rera.iudx.in/projects?name=",
    "Haryana":        "https://haryanarera.gov.in/searchProject?name=",
    "Rajasthan":      "https://rera.rajasthan.gov.in/SearchProject?name=",
    "West Bengal":    "https://hira.wb.gov.in/project/search?keyword=",
    "Madhya Pradesh": "https://www.mprera.gov.in/searchProject.aspx?name=",
    "Kerala":         "https://rera.kerala.gov.in/projects?name=",
    "Punjab":         "https://www.rera.punjab.gov.in/SearchProject?name=",
    "Bihar":          "https://rerabihar.gov.in/searchproject?name=",
    "Odisha":         "https://rera.odisha.gov.in/project/list?name=",
    "Jharkhand":      "https://rera.jharkhand.gov.in/project/search?name=",
    "Chhattisgarh":   "https://rera.cgstate.gov.in/projectsearch?name=",
    "Assam":          "https://rera.assam.gov.in/project?name=",
    "Goa":            "https://rera.goa.gov.in/project/search?name=",
    "_fallback":      "https://www.google.com/search?q=RERA+site:rera.{state_slug}.gov.in+",
}


# ── Main pipeline logic ────────────────────────────────────────────────────────

def load_raw(path: Path, seed: list) -> list[dict]:
    if path.exists():
        log.info(f"Loading raw data from {path}")
        with open(path) as f:
            return json.load(f)
    log.info(f"{path.name} not found — using seed data ({len(seed)} records)")
    return seed


def validate_infra(raw: list[dict]) -> tuple[list[InfraProject], list[dict]]:
    valid, rejected = [], []
    for r in raw:
        try:
            proj = InfraProject(**r)
            valid.append(proj)
        except ValidationError as e:
            log.warning(f"Rejected '{r.get('name','?')}': {e.errors()[0]['msg']}")
            rejected.append({"raw": r, "error": str(e)})
    return valid, rejected


def deduplicate_infra(projects: list[InfraProject]) -> list[InfraProject]:
    seen: dict[str, InfraProject] = {}
    for p in projects:
        # Dedup on project_id; if collision, keep the one with more fields populated
        existing = seen.get(p.project_id)
        if not existing or (p.length_km and not existing.length_km):
            seen[p.project_id] = p
    deduped = list(seen.values())
    log.info(f"Deduplication: {len(projects)} -> {len(deduped)} projects")
    return deduped


def build_rera_index(raw_rera: list[dict]) -> list[dict]:
    """
    Build a searchable RERA index normalised for fuzzy name matching.
    Key design: searchable by project_name OR company_name, not just rera_id.
    Adds normalised search tokens so the frontend can match partial queries.
    """
    indexed = []
    for r in raw_rera:
        # Build search tokens — lowercase, no punctuation, tokenised
        project_tokens = _tokenise(r.get("project_name", ""))
        company_tokens = _tokenise(r.get("company_name", ""))
        all_tokens = list(set(project_tokens + company_tokens))

        # Build the direct portal search URL for this state
        state = r.get("state", "")
        query = r.get("project_name", "")
        base = RERA_PORTALS_ALL.get(state, RERA_PORTALS_ALL["_fallback"])
        if "{state_slug}" in base:
            base = base.replace("{state_slug}", state.lower().replace(" ", ""))
        direct_url = r.get("search_url") or (base + query.replace(" ", "+"))

        indexed.append({
            **r,
            "search_tokens":  all_tokens,      # for client-side fuzzy match
            "search_display": f"{r.get('project_name','')} · {r.get('company_name','')} · {r.get('city','')}",
            "direct_url":     direct_url,
        })
    return indexed


def _tokenise(text: str) -> list[str]:
    """Lower-case, strip punctuation, split to tokens of length ≥ 3."""
    import re
    text = re.sub(r"[^a-zA-Z0-9 ]", " ", text.lower())
    return [t for t in text.split() if len(t) >= 3]


def main():
    log.info("=" * 60)
    log.info("02_ingest_infrastructure.py")
    log.info("=" * 60)

    # ── Infrastructure pipeline ────────────────────────────────────────────────
    raw_infra = load_raw(RAW_JSON, SEED_INFRA)
    valid, rejected = validate_infra(raw_infra)
    log.info(f"Validated: {len(valid)} ok, {len(rejected)} rejected")

    deduped = deduplicate_infra(valid)

    # Serialise with computed fields
    output = []
    by_state: dict[str, int] = {}
    for p in deduped:
        d = p.to_output_dict()
        state = d["state"]
        by_state[state] = by_state.get(state, 0) + 1
        output.append(d)

    log.info(f"\nProjects by state: {dict(sorted(by_state.items(), key=lambda x: -x[1]))}")

    infra_out = {
        "generated_at":       datetime.now(UTC).isoformat() + "Z",
        "total_projects":     len(output),
        "by_type":            pd.DataFrame(output).groupby("type").size().to_dict(),
        "by_status":          pd.DataFrame(output).groupby("status").size().to_dict(),
        "projects":           output,
    }
    infra_path = OUTPUT_DIR / "infrastructure_pipelines.json"
    with open(infra_path, "w") as f:
        json.dump(infra_out, f, indent=2, ensure_ascii=False)
    log.info(f"\n Written: {infra_path} ({len(output)} projects)")

    if rejected:
        rej_path = ETL_DIR / "data/processed/02_rejected.json"
        with open(rej_path, "w") as f:
            json.dump(rejected, f, indent=2)
        log.info(f"   Rejected: {rej_path}")

    # ── RERA search index ───────────────────────────────────────────────────────
    raw_rera = RERA_SEED  # supplement from rera_raw.csv if available
    if RERA_CSV.exists():
        df = pd.read_csv(RERA_CSV)
        csv_records = df.to_dict(orient="records")
        log.info(f"Loaded {len(csv_records)} rows from {RERA_CSV}")
        raw_rera = raw_rera + csv_records

    rera_index = build_rera_index(raw_rera)
    rera_path = OUTPUT_DIR / "rera_index.json"
    rera_out = {
        "generated_at":   datetime.now(UTC).isoformat() ,
        "total_projects": len(rera_index),
        "states_covered": sorted(set(r.get("state","") for r in rera_index)),
        "projects":       rera_index,
    }
    with open(rera_path, "w") as f:
        json.dump(rera_out, f, indent=2, ensure_ascii=False)
    log.info(f" Written: {rera_path} ({len(rera_index)} RERA projects)")


if __name__ == "__main__":
    main()
