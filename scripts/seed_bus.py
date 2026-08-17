"""Phase 2 — bus stops from MARTA's GTFS feed. Drops/rebuilds the GIST index around the load —
run AFTER rail (Phase 1) and BEFORE POIs (Phase 3). See docs/seeding.md for the ordering rule."""
import csv
import io
import os
import zipfile

import psycopg2
import requests

GTFS_URL = "https://www.itsmarta.com/google_transit_feed/google_transit.zip"


def fetch_bus_stops():
    resp = requests.get(GTFS_URL, timeout=60)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
        with z.open("stops.txt") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
            for row in reader:
                if row.get("location_type", "0") not in ("", "0"):
                    continue  # skip stations/entrances, keep individual stops only
                yield row


def seed_bus(conn):
    with conn.cursor() as cur:
        cur.execute("DROP INDEX IF EXISTS idx_marta_stops_location")

        cur.execute(
            """
            CREATE TEMP TABLE tmp_bus (
              stop_id TEXT, name TEXT, lon FLOAT, lat FLOAT, gtfs_stop_id TEXT
            ) ON COMMIT DROP
            """
        )

        buf = io.StringIO()
        writer = csv.writer(buf)
        count = 0
        for row in fetch_bus_stops():
            stop_id = f"BUS_{row['stop_id']}"
            writer.writerow([stop_id, row["stop_name"], row["stop_lon"], row["stop_lat"], row["stop_id"]])
            count += 1
        buf.seek(0)
        cur.copy_expert("COPY tmp_bus FROM STDIN WITH CSV", buf)

        cur.execute(
            """
            INSERT INTO marta_stops (stop_id, name, stop_type, location, gtfs_stop_id)
            SELECT stop_id, name, 'bus', ST_MakePoint(lon, lat)::GEOGRAPHY, gtfs_stop_id
            FROM tmp_bus
            ON CONFLICT (stop_id) DO UPDATE SET
              name = EXCLUDED.name,
              location = EXCLUDED.location,
              gtfs_stop_id = EXCLUDED.gtfs_stop_id,
              updated_at = now()
            """
        )

        cur.execute("CREATE INDEX idx_marta_stops_location ON marta_stops USING GIST (location)")
        cur.execute("CLUSTER marta_stops USING idx_marta_stops_location")
        cur.execute("ANALYZE marta_stops")
    conn.commit()
    print(f"[bus] seeded {count} bus stops")


if __name__ == "__main__":
    db_url = os.environ.get("DATABASE_URL", "postgresql://localhost/skipper")
    conn = psycopg2.connect(db_url)
    try:
        seed_bus(conn)
    finally:
        conn.close()
