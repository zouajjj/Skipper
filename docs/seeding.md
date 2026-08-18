# Seeding

Three-phase pipeline. Each phase is independently runnable, idempotent, and safe to re-run.
Always run in order: rail → bus → POIs. Never skip rail — it's the FK anchor for everything else.

---

## Quick Start

```bash
# Full Atlanta seed (~27s)
python scripts/run_seed.py --db postgresql://localhost/skipper

# Rail only (< 1s, safe at any time)
python scripts/run_seed.py --phases rail

# Eateries only (after bus stops exist)
python scripts/run_seed.py --phases poi

# Full POI set — all amenity categories, not just eateries (~90s)
python scripts/run_seed.py --phases poi --all-pois
```

---

## Phase 1 — Rail Stops

**Source:** `scripts/rail_stops_atlanta.csv` (38 stations + 4 streetcar stops)
**Duration:** < 1 second
**Index impact:** None — GIST index stays live throughout

Strategy: COPY via temp table. The temp table is typed loosely (TEXT/FLOAT), the COPY fills
it, then a typed INSERT with `ST_MakePoint(lon, lat)::GEOGRAPHY` and `string_to_array` converts
into the production schema. `ON CONFLICT DO UPDATE` makes it safe to re-run.

```python
# scripts/seed_rail.py — simplified
cur.execute("CREATE TEMP TABLE tmp_rail (stop_id TEXT, name TEXT, stop_type TEXT, lon FLOAT, lat FLOAT, lines TEXT) ON COMMIT DROP")
cur.copy_expert("COPY tmp_rail FROM STDIN WITH CSV HEADER", open('scripts/rail_stops_atlanta.csv'))
cur.execute("""
    INSERT INTO marta_stops (stop_id, name, stop_type, location, lines)
    SELECT stop_id, name, stop_type,
      ST_MakePoint(lon, lat)::GEOGRAPHY,
      string_to_array(trim(both '{}' from lines), ',')
    FROM tmp_rail
    ON CONFLICT (stop_id) DO UPDATE SET
      name=EXCLUDED.name, location=EXCLUDED.location, lines=EXCLUDED.lines, updated_at=now()
""")
```

After the stop load, `seed_rail.py` also writes the ordered per-line stop sequence into
`marta_lines.stop_ids` (four `LINE_SEQUENCES` constants, one per RED/GOLD/BLUE/GREEN — same
values as `LINE_PATHS` embedded in `public/skipper.html`, kept in sync by hand since the
frontend has no build step to share a module). This is what the routing graph
(`src/routing/graph.ts`) walks for rail adjacency — without it, `marta_lines.stop_ids` sits
unused even though the schema column has always existed.

---

## Phase 2 — Bus Stops

**Source:** MARTA GTFS `google_transit.zip` → `stops.txt` (location_type=0)
**URL:** `https://www.itsmarta.com/google_transit_feed/google_transit.zip`
**Duration:** ~4s (Atlanta ~7,000 stops)
**Index impact:** Drops and rebuilds GIST index around the load

Strategy: DROP index → COPY → INSERT → CREATE index → CLUSTER → ANALYZE.
Rebuilding after load is ~3× faster than incremental GIST updates during INSERT.
The index-absent window is ~2s and is safe during seeding (no queries run during seed).

```python
# scripts/seed_bus.py — key steps
cur.execute("DROP INDEX IF EXISTS idx_marta_stops_location")
# ... COPY ~7,000 rows into tmp_bus ...
cur.execute("INSERT INTO marta_stops ... ON CONFLICT DO UPDATE")
cur.execute("CREATE INDEX idx_marta_stops_location ON marta_stops USING GIST (location)")
cur.execute("CLUSTER marta_stops USING idx_marta_stops_location")
cur.execute("ANALYZE marta_stops")
```

**Route topology sub-step (same GTFS zip, no extra download):** `stops.txt` alone gives no
route information — a bus stop had no route number attached to it at all until this sub-step
existed. `seed_bus.py` also reads `routes.txt`, `trips.txt`, and `stop_times.txt` from the same
zip and extracts one canonical ordered stop sequence per `(route_id, direction_id)`:

1. Build `trip_id → (route_id, direction_id, headsign)` from `trips.txt`.
2. Pass 1 over `stop_times.txt`: count stops per `trip_id` (bounded memory — one counter per
   trip, not per row).
3. Pick the longest trip per `(route_id, direction_id)` as its representative shape — this is
   deliberately *not* a full schedule import (MARTA's `stop_times.txt` is millions of rows;
   see the numbers below), just enough topology for graph routing.
4. Pass 2 over `stop_times.txt`: collect the ordered `(stop_sequence, stop_id)` pairs only for
   the winning `trip_id`s, insert into `route_stops`.
5. `UPDATE marta_stops SET lines = ...` from the distinct route short names now in
   `route_stops`, per bus stop — this is what finally populates `lines` for bus stops.

Two passes over `stop_times.txt` (rather than one) avoid depending on the file being sorted by
`trip_id`, at the cost of reading it twice — both are cheap streaming CSV scans, no full
materialization.

---

## Phase 3 — POIs

**Source:** Overpass API (OpenStreetMap)
**Duration:** ~23s (Atlanta eateries), ~90s (all amenities)
**Index impact:** None — separate `pois` table, separate GIST index

Strategy: Tile the Atlanta bbox into 2×2 quadrants (4 tiles). Each tile returns <8,000 elements,
staying under Overpass's soft limit. Each tile is COPYed into a temp table and upserted.

```python
# Atlanta bbox split into 2×2 = 4 tiles
ATLANTA_BBOX = (33.647, -84.551, 33.957, -84.289)  # SW lat, SW lon, NE lat, NE lon
EATERY_AMENITIES = "restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|bakery|deli"
```

For the full POI set (all amenity types), use 3×3 tiles (9 requests).
For NYC-scale, use 4×4 tiles (16 requests) with a producer-consumer queue.

**Nightly cron (replace per-request Overpass fetches):**
```bash
# crontab — 3am ET daily
0 3 * * * python /app/scripts/seed_pois.py --db postgresql://localhost/skipper >> /var/log/skipper-seed.log 2>&1
```

---

## Atlanta Reference Numbers

| Dataset | Rows | Seed time | Cadence |
|---|---|---|---|
| Rail stations | 38 | < 1s | On GTFS release |
| Bus stops | ~7,000 | ~4s | On GTFS release / NextGen updates |
| Eatery POIs | ~4,500 | ~23s | Nightly |
| All amenity POIs | ~22,000 | ~90s | Weekly |
| GTFS stop_times | ~2–4M | ~40s | On GTFS release |
| `route_stops` (canonical shapes) | ~81 routes × 2 directions × ~avg stops | few seconds (two streaming passes over stop_times.txt) | On GTFS release |

---

## City Scaling Formula

To onboard a new city, estimate rows and seed time:

```python
bus_stops_estimate   = (agency_route_count / 81) * 7000   # MARTA has 81 routes
poi_estimate         = (metro_pop / 6_000_000) * 4500     # Atlanta metro pop
tiles_needed         = math.ceil(poi_estimate / 8000)     # keep each tile < 8k elements
seed_time_estimate   = (bus_stops / 7000 * 4) + (tiles_needed * 7)  # seconds
```

| City | Rail | Bus | Eateries | Tiles | Est. time |
|---|---|---|---|---|---|
| Atlanta (baseline) | 38 | 7,000 | 4,500 | 4 | ~27s |
| Houston | 25 | 9,500 | 5,500 | 4 | ~35s |
| Chicago | 145 | 11,000 | 12,000 | 9 | ~55s |
| Los Angeles | 90 | 14,000 | 18,000 | 9 | ~75s |
| New York City | 500 | 16,000 | 40,000 | 16 | ~3 min |

**City bounding boxes:**
```python
CITY_BBOXES = {
  'atlanta':     (33.647, -84.551, 33.957, -84.289),
  'houston':     (29.523, -95.789, 30.108, -95.014),
  'chicago':     (41.644, -87.937, 42.082, -87.524),
  'los_angeles': (33.703, -118.668, 34.337, -118.155),
  'new_york':    (40.477, -74.259, 40.917, -73.700),
}
```

---

## Staleness & Update Triggers

| Table | Trigger | Max staleness |
|---|---|---|
| `marta_stops` (rail) | New MARTA GTFS zip published | Manual / per release |
| `marta_stops` (bus) | NextGen network updates | Manual / per release |
| `pois` | Nightly cron at 3am ET | 48 hours |
| `route_cache` | TTL-based expiry (24h) | 24 hours |
| `stop_times` | New MARTA GTFS zip | Manual / per release |
| `route_stops` | New MARTA GTFS zip (rebuilt each bus-phase run) | Manual / per release |

---

## Idempotency Guarantee

Every INSERT in every seed script uses `ON CONFLICT DO UPDATE`. This means:
- Re-running any phase against an already-seeded database is safe
- A seed that fails mid-run can be retried from the beginning
- Deploying seed scripts in CI on every deploy is safe
