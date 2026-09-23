"""ANAVANDI water logging MVP. SQLite storage; all demo data is explicitly synthetic."""
import hashlib
import json
import math
import os
import sqlite3
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

DB_PATH = Path(os.getenv("DB_PATH", str(Path(__file__).parent / "waterwatch.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="WaterWatch Panchayat API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"http://(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5173",
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type"],
)

@contextmanager
def db_session():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

with db_session() as db:
    db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS tests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id TEXT NOT NULL UNIQUE,
            household_id TEXT NOT NULL,
            ward_id TEXT NOT NULL,
            test_type TEXT NOT NULL,
            result TEXT NOT NULL CHECK(result IN ('positive', 'negative')),
            tested_at TEXT NOT NULL,
            latitude REAL,
            longitude REAL,
            source TEXT NOT NULL DEFAULT 'user',
            fingerprint TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS rainfall (
            ward_id TEXT NOT NULL,
            date TEXT NOT NULL,
            rainfall_mm REAL NOT NULL,
            source TEXT NOT NULL DEFAULT 'import',
            PRIMARY KEY (ward_id, date)
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS simulated_alerts (
            cluster_id TEXT PRIMARY KEY,
            simulated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)


class TestIn(BaseModel):
    client_id: str = Field(default_factory=lambda: str(uuid4()), min_length=1, max_length=100)
    household_id: str = Field(min_length=1, max_length=100)
    ward_id: str = Field(min_length=1, max_length=100)
    test_type: str = Field(min_length=1, max_length=100)
    result: Literal["positive", "negative"]
    tested_at: date
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    source: Literal["user", "import", "demo"] = "user"

    @model_validator(mode="after")
    def check_coordinates(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Provide both latitude and longitude, or leave both blank.")
        return self


class RainIn(BaseModel):
    ward_id: str = Field(min_length=1, max_length=100)
    date: date
    rainfall_mm: float = Field(ge=0, le=10000)


class BulkIn(BaseModel):
    tests: list[TestIn] = Field(default_factory=list)
    rainfall: list[RainIn] = Field(default_factory=list)
    ward_geojson: dict | None = None


def fingerprint(t: TestIn) -> str:
    # Identical household/type/result/day/location is treated as accidental duplicate.
    parts = [t.household_id.strip().lower(), t.ward_id.strip().lower(),
             t.test_type.strip().lower(), t.result, t.tested_at.isoformat(),
             str(round(t.latitude, 5)) if t.latitude is not None else "none",
             str(round(t.longitude, 5)) if t.longitude is not None else "none"]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def insert_test(db, t: TestIn) -> tuple[int, bool]:
    fp = fingerprint(t)
    existing = db.execute("SELECT id FROM tests WHERE client_id = ? OR fingerprint = ?", (t.client_id, fp)).fetchone()
    if existing:
        return existing["id"], True
    cursor = db.execute("""INSERT INTO tests
        (client_id, household_id, ward_id, test_type, result, tested_at,
         latitude, longitude, source, fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (t.client_id, t.household_id.strip(), t.ward_id.strip(),
         t.test_type.strip(), t.result, t.tested_at.isoformat(),
         t.latitude, t.longitude, t.source, fp))
    return cursor.lastrowid, False


def km_between(a_lat, a_lon, b_lat, b_lon):
    lat1, lat2 = math.radians(a_lat), math.radians(b_lat)
    dlat = lat2 - lat1
    dlon = math.radians(b_lon - a_lon)
    h = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2)**2
    return 6371.0 * 2 * math.asin(min(1, math.sqrt(h)))


@app.get("/api/health")
def health():
    return {"status": "ok", "database": "sqlite", "app": "WaterWatch"}


@app.post("/api/tests")
def add_test(test: TestIn):
    with db_session() as db:
        identifier, duplicate = insert_test(db, test)
    return {"id": identifier, "duplicate": duplicate, "status": "already_exists" if duplicate else "saved",
            "location_missing": test.latitude is None}


@app.get("/api/tests")
def list_tests():
    with db_session() as db:
        return [dict(row) for row in db.execute("SELECT * FROM tests ORDER BY tested_at DESC, id DESC LIMIT 500").fetchall()]


class LocationIn(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


@app.patch("/api/tests/{test_id}/location")
def fix_location(test_id: int, location: LocationIn):
    with db_session() as db:
        row = db.execute("SELECT * FROM tests WHERE id = ?", (test_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Test not found")
        if row["latitude"] is not None:
            raise HTTPException(409, "Location already recorded")
        db.execute("UPDATE tests SET latitude = ?, longitude = ? WHERE id = ?",
                   (location.latitude, location.longitude, test_id))
    return {"status": "updated", "id": test_id}


@app.post("/api/import/bulk")
def bulk_import(payload: BulkIn):
    if len(payload.tests) > 5000 or len(payload.rainfall) > 5000:
        raise HTTPException(413, "Import up to 5000 records per type per request")
    geo = payload.ward_geojson
    if geo is not None:
        if geo.get("type") != "FeatureCollection" or not isinstance(geo.get("features"), list):
            raise HTTPException(422, "Ward boundaries must be GeoJSON FeatureCollection")
        if len(json.dumps(geo)) > 5_000_000:
            raise HTTPException(413, "GeoJSON must be under 5 MB")
    added = duplicate = 0
    with db_session() as db:
        for t in payload.tests:
            _, is_duplicate = insert_test(db, t)
            duplicate += int(is_duplicate)
            added += int(not is_duplicate)
        for r in payload.rainfall:
            db.execute("""INSERT INTO rainfall(ward_id,date,rainfall_mm,source) VALUES(?,?,?,'import')
                ON CONFLICT(ward_id,date) DO UPDATE SET rainfall_mm=excluded.rainfall_mm,source='import'""",
                (r.ward_id, r.date.isoformat(), r.rainfall_mm))
        if geo is not None:
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('ward_geojson',?)", (json.dumps(geo),))
    return {"added_tests": added, "duplicate_tests": duplicate,
            "rainfall_records": len(payload.rainfall), "ward_boundaries_imported": geo is not None}


@app.get("/api/ward-boundaries")
def ward_boundaries():
    with db_session() as db:
        row = db.execute("SELECT value FROM meta WHERE key = 'ward_geojson'").fetchone()
    return json.loads(row["value"]) if row else {"type": "FeatureCollection", "features": []}


def compute_dashboard(min_positive: int, radius_km: float, window_days: int, rainfall_threshold_mm: float,
                      alert_radius_km: float):
    with db_session() as db:
        tests = [dict(x) for x in db.execute("SELECT * FROM tests ORDER BY tested_at DESC").fetchall()]
        rain = [dict(x) for x in db.execute("SELECT * FROM rainfall").fetchall()]
        simulated = {x["cluster_id"] for x in db.execute("SELECT cluster_id FROM simulated_alerts").fetchall()}
    if not tests:
        return {"reference_date": None, "tests": [], "clusters": [], "wards": [], "stats":
                {"total": 0, "positive": 0, "negative": 0, "missing_location": 0, "clusters": 0},
                "settings": {"min_positive": min_positive, "radius_km": radius_km,
                             "window_days": window_days, "rainfall_threshold_mm": rainfall_threshold_mm,
                             "alert_radius_km": alert_radius_km}}
    reference = max(date.fromisoformat(t["tested_at"]) for t in tests)
    cutoff = reference - timedelta(days=window_days - 1)
    recent = [t for t in tests if date.fromisoformat(t["tested_at"]) >= cutoff]
    wards = defaultdict(lambda: {"ward_id": "", "total": 0, "positive": 0, "negative": 0,
                                 "missing_location": 0, "rainfall_mm": 0.0, "clusters": 0})
    for t in recent:
        w = wards[t["ward_id"]]
        w["ward_id"] = t["ward_id"]
        w["total"] += 1
        w[t["result"]] += 1
        w["missing_location"] += int(t["latitude"] is None)
    for r in rain:
        rd = date.fromisoformat(r["date"])
        if reference - timedelta(days=2) <= rd <= reference:
            w = wards[r["ward_id"]]
            w["ward_id"] = r["ward_id"]
            w["rainfall_mm"] += r["rainfall_mm"]

    candidates = [t for t in recent if t["result"] == "positive" and t["latitude"] is not None]
    components = []
    unseen = {t["id"]: t for t in candidates}
    while unseen:
        start_id = next(iter(unseen))
        queue = [unseen.pop(start_id)]
        component = []
        while queue:
            current = queue.pop()
            component.append(current)
            for other_id, other in list(unseen.items()):
                if current["test_type"].casefold() == other["test_type"].casefold() and \
                    km_between(current["latitude"], current["longitude"], other["latitude"], other["longitude"]) <= radius_km:
                    queue.append(unseen.pop(other_id))
        if len({t["household_id"] for t in component}) >= min_positive:
            components.append(component)
    clusters = []
    for comp in components:
        lat = sum(t["latitude"] for t in comp) / len(comp)
        lon = sum(t["longitude"] for t in comp) / len(comp)
        ward_id = Counter(t["ward_id"] for t in comp).most_common(1)[0][0]
        ids = sorted(t["id"] for t in comp)
        cluster_id = hashlib.sha256(",".join(map(str, ids)).encode()).hexdigest()[:12]
        households = {t["household_id"] for t in recent if t["latitude"] is not None and
                      km_between(lat, lon, t["latitude"], t["longitude"]) <= alert_radius_km}
        rain_3d = round(wards[ward_id]["rainfall_mm"], 1)
        wards[ward_id]["clusters"] += 1
        clusters.append({"id": cluster_id, "test_type": comp[0]["test_type"],
                         "positive_count": len(comp), "unique_households": len({t["household_id"] for t in comp}),
                         "latitude": round(lat, 6), "longitude": round(lon, 6), "ward_id": ward_id,
                         "rainfall_mm_3d": rain_3d, "rainfall_flag": rain_3d >= rainfall_threshold_mm,
                         "simulated_households": len(households), "alert_radius_km": alert_radius_km,
                         "alert_simulated": cluster_id in simulated,
                         "test_ids": ids})
    clusters.sort(key=lambda c: (-c["positive_count"], c["ward_id"]))
    ward_rows = sorted(wards.values(), key=lambda w: (-w["clusters"], -w["positive"], w["ward_id"]))
    return {"reference_date": reference.isoformat(), "tests": recent, "clusters": clusters,
            "wards": ward_rows, "stats": {"total": len(recent),
                "positive": sum(t["result"] == "positive" for t in recent),
                "negative": sum(t["result"] == "negative" for t in recent),
                "missing_location": sum(t["latitude"] is None for t in recent), "clusters": len(clusters)},
            "settings": {"min_positive": min_positive, "radius_km": radius_km,
                         "window_days": window_days, "rainfall_threshold_mm": rainfall_threshold_mm,
                         "alert_radius_km": alert_radius_km}}


@app.get("/api/dashboard")
def dashboard(min_positive: int = Query(2, ge=2, le=20),
              radius_km: float = Query(2.0, gt=0, le=50),
              window_days: int = Query(14, ge=1, le=365),
              rainfall_threshold_mm: float = Query(30.0, ge=0, le=1000),
              alert_radius_km: float = Query(3.0, gt=0, le=50)):
    return compute_dashboard(min_positive, radius_km, window_days, rainfall_threshold_mm, alert_radius_km)


class SimulateIn(BaseModel):
    min_positive: int = Field(2, ge=2, le=20)
    radius_km: float = Field(2.0, gt=0, le=50)
    window_days: int = Field(14, ge=1, le=365)
    rainfall_threshold_mm: float = Field(30.0, ge=0, le=1000)
    alert_radius_km: float = Field(3.0, gt=0, le=50)


@app.post("/api/alerts/{cluster_id}/simulate")
def simulate(cluster_id: str, settings: SimulateIn):
    result = compute_dashboard(**settings.model_dump())
    cluster = next((x for x in result["clusters"] if x["id"] == cluster_id), None)
    if not cluster:
        raise HTTPException(404, "Cluster no longer exists for these settings")
    with db_session() as db:
        db.execute("INSERT OR IGNORE INTO simulated_alerts(cluster_id) VALUES (?)", (cluster_id,))
    return {"status": "simulated_only", "cluster_id": cluster_id,
            "households_represented_in_data": cluster["simulated_households"],
            "guidance": "Potential contamination signal. Confirm through authorised water testing and follow approved local public-health guidance."}


@app.post("/api/demo/load")
def load_demo():
    today = date.today()
    # Synthetic coordinates near Kochi: illustrative only, not observed contamination.
    rows = [
        ("HH-101", "Demo Ward A", "E. coli", "positive", 9.9670, 76.2860, 0),
        ("HH-102", "Demo Ward A", "E. coli", "positive", 9.9700, 76.2880, 0),
        ("HH-103", "Demo Ward A", "E. coli", "negative", 9.9680, 76.2850, 0),
        ("HH-104", "Demo Ward A", "E. coli", "positive", 9.9710, 76.2900, 1),
        ("HH-201", "Demo Ward B", "E. coli", "negative", 9.9990, 76.3100, 0),
        ("HH-202", "Demo Ward B", "Coliform", "positive", 9.9980, 76.3090, 0),
        ("HH-203", "Demo Ward B", "Coliform", "positive", 9.9990, 76.3100, 1),
        ("HH-204", "Demo Ward B", "Coliform", "negative", None, None, 0),
    ]
    added = 0
    with db_session() as db:
        for index, (hh, ward, typ, result, lat, lon, age) in enumerate(rows):
            t = TestIn(client_id=f"synthetic-demo-{index}", household_id=hh, ward_id=ward,
                       test_type=typ, result=result, tested_at=today - timedelta(days=age),
                       latitude=lat, longitude=lon, source="demo")
            _, duplicate = insert_test(db, t)
            added += int(not duplicate)
        for ward, rain_amounts in [("Demo Ward A", [38, 18, 7]), ("Demo Ward B", [2, 3, 0])]:
            for i, mm in enumerate(rain_amounts):
                db.execute("""INSERT OR IGNORE INTO rainfall(ward_id,date,rainfall_mm,source)
                              VALUES(?,?,?,'demo')""", (ward, (today-timedelta(days=i)).isoformat(), mm))
    return {"synthetic_demo_tests_added": added, "note": "Demo data is fictional, not local test results."}


@app.post("/api/demo/clear")
def clear_demo():
    with db_session() as db:
        db.execute("DELETE FROM tests WHERE source='demo'")
        db.execute("DELETE FROM rainfall WHERE source='demo'")
        db.execute("DELETE FROM simulated_alerts")
    return {"status": "demo_data_cleared", "note": "Non-demo imported/user records are preserved."}
