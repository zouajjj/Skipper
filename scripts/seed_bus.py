"""Phase 2 — bus stops + route topology from MARTA's GTFS feed. Drops/rebuilds the GIST index
around the stop load — run AFTER rail (Phase 1) and BEFORE POIs (Phase 3). See docs/seeding.md
for the ordering rule.

Also extracts one canonical ordered stop sequence per (route_id, direction_id) into
route_stops, so the routing graph (src/routing/graph.ts) knows which bus stops are served by
which routes, in what order — without importing the full GTFS stop_times table (millions of
rows; see docs/seeding.md for why that's out of scope)."""
import csv
import io
import os
import zipfile

import psycopg2
import requests

GTFS_URL = "https://www.itsmarta.com/google_transit_feed/google_transit.zip"


def fetch_bus_stops(z):
    with z.open("stops.txt") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        for row in reader:
            if row.get("location_type", "0") not in ("", "0"):
                continue  # skip stations/entrances, keep individual stops only
            yield row


def build_route_stops(z):
    """Two-pass extraction of one representative (longest) trip per route+direction.

    Pass 1: count stops per trip_id (bounded memory — one counter per trip, not per row).
    Pass 2: re-read stop_times.txt and keep only the rows belonging to the winning trip_id
    for each (route_id, direction_id). Two passes avoid assuming stop_times.txt is sorted by
    trip_id, at the cost of reading the file twice — both reads are cheap streaming CSV scans.
    """
    with z.open("routes.txt") as f:
        route_names = {
            row["route_id"]: row.get("route_short_name") or row.get("route_long_name") or row["route_id"]
            for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        }

    with z.open("trips.txt") as f:
        trip_info = {}
        for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            direction_id = int(row.get("direction_id") or 0)
            trip_info[row["trip_id"]] = (row["route_id"], direction_id, row.get("trip_headsign") or "")

    # Pass 1 — stop counts per trip.
    stop_counts = {}
    with z.open("stop_times.txt") as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            trip_id = row["trip_id"]
            stop_counts[trip_id] = stop_counts.get(trip_id, 0) + 1

    # Pick the longest trip per (route_id, direction_id).
    best_trip = {}  # (route_id, direction_id) -> (trip_id, stop_count)
    for trip_id, count in stop_counts.items():
        info = trip_info.get(trip_id)
        if info is None:
            continue
        route_id, direction_id, _headsign = info
        key = (route_id, direction_id)
        if key not in best_trip or count > best_trip[key][1]:
            best_trip[key] = (trip_id, count)
    winning_trip_ids = {trip_id for trip_id, _count in best_trip.values()}

    # Pass 2 — collect the ordered stop sequence for each winning trip.
    sequences = {trip_id: [] for trip_id in winning_trip_ids}
    with z.open("stop_times.txt") as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            trip_id = row["trip_id"]
            if trip_id in sequences:
                sequences[trip_id].append((int(row["stop_sequence"]), row["stop_id"]))

    route_stops = []  # (route_id, route_short_name, direction_id, headsign, stop_id, stop_sequence)
    for (route_id, direction_id), (trip_id, _count) in best_trip.items():
        _route_id2, _direction_id2, headsign = trip_info[trip_id]
        for seq, stop_id in sorted(sequences[trip_id]):
            route_stops.append((route_id, route_names.get(route_id, route_id), direction_id, headsign, f"BUS_{stop_id}", seq))

    return route_stops


def seed_bus(conn):
    resp = requests.get(GTFS_URL, timeout=60)
    resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
        with conn.cursor() as cur:
            cur.execute("DROP INDEX IF EXISTS idx_marta_stops_location")

            cur.execute(
                """
                CREATE TEMP TABLE tmp_bus (
                  stop_id TEXT, name TEXT, lon FLOAT, lat FLOAT, gtfs_stop_id TEXT, platform_code TEXT
                ) ON COMMIT DROP
                """
            )

            buf = io.StringIO()
            writer = csv.writer(buf)
            count = 0
            for row in fetch_bus_stops(z):
                stop_id = f"BUS_{row['stop_id']}"
                writer.writerow([
                    stop_id, row["stop_name"], row["stop_lon"], row["stop_lat"],
                    row["stop_id"], row.get("platform_code") or "",
                ])
                count += 1
            buf.seek(0)
            cur.copy_expert("COPY tmp_bus FROM STDIN WITH CSV", buf)

            cur.execute(
                """
                INSERT INTO marta_stops (stop_id, name, stop_type, location, gtfs_stop_id, platform_code)
                SELECT stop_id, name, 'bus', ST_MakePoint(lon, lat)::GEOGRAPHY, gtfs_stop_id,
                  NULLIF(platform_code, '')
                FROM tmp_bus
                ON CONFLICT (stop_id) DO UPDATE SET
                  name = EXCLUDED.name,
                  location = EXCLUDED.location,
                  gtfs_stop_id = EXCLUDED.gtfs_stop_id,
                  platform_code = EXCLUDED.platform_code,
                  updated_at = now()
                """
            )

            cur.execute("CREATE INDEX idx_marta_stops_location ON marta_stops USING GIST (location)")
            cur.execute("CLUSTER marta_stops USING idx_marta_stops_location")
            cur.execute("ANALYZE marta_stops")
        conn.commit()
        print(f"[bus] seeded {count} bus stops")

        route_stops = build_route_stops(z)
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TEMP TABLE tmp_route_stops (
                  route_id TEXT, route_short_name TEXT, direction_id INT, headsign TEXT,
                  stop_id TEXT, stop_sequence INT
                ) ON COMMIT DROP
                """
            )
            rbuf = io.StringIO()
            rwriter = csv.writer(rbuf)
            for row in route_stops:
                rwriter.writerow(row)
            rbuf.seek(0)
            cur.copy_expert("COPY tmp_route_stops FROM STDIN WITH CSV", rbuf)

            cur.execute("DELETE FROM route_stops")
            cur.execute(
                """
                INSERT INTO route_stops (route_id, route_short_name, direction_id, headsign, stop_id, stop_sequence)
                SELECT route_id, route_short_name, direction_id, headsign, stop_id, stop_sequence
                FROM tmp_route_stops trs
                WHERE EXISTS (SELECT 1 FROM marta_stops s WHERE s.stop_id = trs.stop_id)
                """
            )

            cur.execute(
                """
                UPDATE marta_stops s SET lines = sub.routes, updated_at = now()
                FROM (
                  SELECT stop_id, array_agg(DISTINCT route_short_name ORDER BY route_short_name) AS routes
                  FROM route_stops GROUP BY stop_id
                ) sub
                WHERE s.stop_id = sub.stop_id AND s.stop_type = 'bus'
                """
            )
        conn.commit()
        print(f"[bus] seeded {len(route_stops)} route_stops rows across {len({(r[0], r[2]) for r in route_stops})} route/direction pairs")


if __name__ == "__main__":
    db_url = os.environ.get("DATABASE_URL", "postgresql://localhost/skipper")
    conn = psycopg2.connect(db_url)
    try:
        seed_bus(conn)
    finally:
        conn.close()
