# Database

PostgreSQL 16 + PostGIS 3.4. All geographic data stored as `GEOGRAPHY(POINT, 4326)`.

---

## Setup

```sql
-- Run once as superuser
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
```

---

## Schema

### `marta_stops` — unified rail + bus stop table

```sql
CREATE TABLE marta_stops (
  stop_id       TEXT PRIMARY KEY,       -- 'KING', 'FIVE_PTS', 'BUS_3_KM_A', GTFS IDs
  name          TEXT NOT NULL,
  stop_type     TEXT NOT NULL CHECK (stop_type IN ('rail','bus','streetcar')),
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  lines         TEXT[],                 -- {RED,GOLD} or {3,26} or {BLUE,GREEN} — populated for
                                         -- bus stops from route_stops, not just rail
  gtfs_stop_id  TEXT,                   -- raw GTFS stop_id for stop_times joins
  platform_code TEXT,                   -- bay/platform label, only if the GTFS feed has one —
                                         -- never fabricated when absent
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_marta_stops_location ON marta_stops USING GIST (location);
CREATE INDEX idx_marta_stops_type     ON marta_stops (stop_type);
```

**Stop ID conventions:**
- Rail stations: short uppercase codes — `KING`, `FIVE_PTS`, `GEORGIA_ST`
- Bus stops: `BUS_{route}_{location}` — `BUS_3_KM_A`, `BUS_9_BLVD1`
- GTFS bus stops: numeric string from stops.txt — `'900123'`

### `marta_lines` — route geometry for canvas rendering

```sql
CREATE TABLE marta_lines (
  line_id    TEXT PRIMARY KEY,          -- 'RED','GOLD','BLUE','GREEN'
  line_name  TEXT NOT NULL,
  color_hex  TEXT NOT NULL,             -- '#ef4444'
  route      GEOGRAPHY(LINESTRING, 4326),
  stop_ids   TEXT[]                     -- ordered stop_id sequence — populated by seed_rail.py,
                                         -- walked by the routing graph for rail adjacency
);
```

### `route_stops` — canonical bus route topology

```sql
CREATE TABLE route_stops (
  route_id         TEXT NOT NULL,
  route_short_name TEXT NOT NULL,       -- '3', '26', ... — what riders call the route
  direction_id     INT NOT NULL,        -- GTFS direction_id (0 or 1); edges are directed
  headsign         TEXT,
  stop_id          TEXT NOT NULL REFERENCES marta_stops(stop_id),
  stop_sequence    INT NOT NULL,
  PRIMARY KEY (route_id, direction_id, stop_sequence)
);

CREATE INDEX idx_route_stops_stop ON route_stops (stop_id);
```

One representative (longest) trip per `(route_id, direction_id)` from GTFS `stop_times.txt` —
not the full multi-million-row schedule. See `docs/seeding.md` Phase 2 and the "Why a
canonical-trip shape" decision in `docs/architecture.md`. This is what lets `src/routing/graph.ts`
build directed bus-route edges and lets `seed_bus.py` finally populate `marta_stops.lines` for
bus stops (previously always NULL).

### `pois` — Points of Interest (eateries + future categories)

```sql
CREATE TABLE pois (
  poi_id      BIGSERIAL PRIMARY KEY,
  osm_id      BIGINT UNIQUE,            -- OpenStreetMap element ID, null for manual entries
  name        TEXT NOT NULL,
  amenity     TEXT NOT NULL,            -- 'restaurant','cafe','bar','fast_food','bakery'...
  cuisine     TEXT,                     -- 'soul_food','burger','pizza'...
  location    GEOGRAPHY(POINT, 4326) NOT NULL,
  address     TEXT,
  phone       TEXT,
  website     TEXT,
  osm_tags    JSONB,                    -- full OSM tag blob for extensibility
  last_synced TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pois_location ON pois USING GIST (location);
CREATE INDEX idx_pois_amenity  ON pois (amenity);
CREATE INDEX idx_pois_osm_id   ON pois (osm_id) WHERE osm_id IS NOT NULL;
```

### `route_cache` — computed route leg cache

```sql
CREATE TABLE route_cache (
  cache_key     TEXT PRIMARY KEY,       -- SHA256(origin_stop_id || dest_stop_id)
  origin_stop   TEXT REFERENCES marta_stops(stop_id),
  dest_stop     TEXT REFERENCES marta_stops(stop_id),
  legs          JSONB NOT NULL,         -- full legs[] array
  total_minutes INT,
  cached_at     TIMESTAMPTZ DEFAULT now()
);
```

### `stop_times` — GTFS schedule (loaded from stop_times.txt)

```sql
CREATE TABLE stop_times (
  trip_id        TEXT NOT NULL,
  stop_id        TEXT NOT NULL,
  stop_sequence  INT NOT NULL,
  arrival_time   INTERVAL,
  departure_time INTERVAL,
  PRIMARY KEY (trip_id, stop_sequence)
);

CREATE INDEX idx_stop_times_stop ON stop_times (stop_id, departure_time);
```

---

## Named Queries

All queries follow this binding convention: `$1=lat, $2=lon, $3=radius_meters`.
**Never swap lat/lon — `ST_MakePoint($2, $1)` means (longitude, latitude).**

### Q1 — Nearby stops (`GET /api/nearby-stops`)

```sql
SELECT
  stop_id,
  name,
  stop_type,
  lines,
  ROUND(
    (ST_Distance(location, ST_MakePoint($2,$1)::GEOGRAPHY) * 0.000621371)::numeric, 3
  ) AS distance_miles
FROM marta_stops
WHERE ST_DWithin(
  location,
  ST_MakePoint($2,$1)::GEOGRAPHY,
  $3                              -- meters: 1609 = 1 mile, 804 = 0.5 mile
)
ORDER BY location <-> ST_MakePoint($2,$1)::GEOGRAPHY
LIMIT 5;
-- Params: [lat, lon, radius_meters]
-- Index:  GIST KNN via <-> operator (~0.4ms on 7k stops)
```

### Q2 — Nearest single stop (route planning)

```sql
SELECT stop_id, name, lines, stop_type,
  ST_Distance(location, ST_MakePoint($2,$1)::GEOGRAPHY) AS dist_meters
FROM marta_stops
WHERE stop_type = $3              -- 'rail' or 'bus' or null for all
ORDER BY location <-> ST_MakePoint($2,$1)::GEOGRAPHY
LIMIT 1;
-- Params: [lat, lon, stop_type]
```

### Q3 — POIs near user (`GET /api/pois`)

```sql
SELECT
  poi_id, name, amenity, cuisine,
  ST_Y(location::GEOMETRY) AS lat,
  ST_X(location::GEOMETRY) AS lon,
  ROUND(
    (ST_Distance(location, ST_MakePoint($2,$1)::GEOGRAPHY) * 0.000621371)::numeric, 3
  ) AS distance_miles
FROM pois
WHERE
  amenity = ANY($4)               -- ARRAY['restaurant','cafe','bar','fast_food']
  AND ST_DWithin(location, ST_MakePoint($2,$1)::GEOGRAPHY, $3)
ORDER BY location <-> ST_MakePoint($2,$1)::GEOGRAPHY
LIMIT $5;                         -- default 30
-- Params: [lat, lon, radius_meters, amenity_array, limit]
```

### Q4 — POIs near a MARTA stop (destination discovery)

```sql
SELECT
  p.poi_id, p.name, p.amenity, p.cuisine,
  ROUND(
    (ST_Distance(p.location, s.location) * 0.000621371)::numeric, 3
  ) AS distance_miles
FROM pois p
JOIN marta_stops s ON s.stop_id = $1
WHERE ST_DWithin(p.location, s.location, $2)
ORDER BY p.location <-> s.location
LIMIT 20;
-- Params: [stop_id, radius_meters]
```

### Q5 — Schedule fallback (when transit API is down)

`trips`/`routes`/`calendar` GTFS static tables were never actually created (this query
previously referenced them and threw on every fallback request). No live schedule import
exists in this scaffold either — `stop_times` is never seeded — so this can only report which
routes serve a stop, not a real departure time:

```sql
SELECT DISTINCT route_id, route_short_name, headsign
FROM route_stops
WHERE stop_id = $1
LIMIT 5;
-- Params: [stop_id]
```

### Q7 — Routes serving a stop (reverse lookup, bus)

```sql
SELECT route_id, route_short_name, direction_id, headsign, stop_sequence
FROM route_stops
WHERE stop_id = $1
ORDER BY route_short_name, direction_id;
-- Params: [stop_id]
```

### Q6 — Staleness check (monitoring)

```sql
SELECT stop_type,
  COUNT(*) AS rows,
  MAX(updated_at) AS last_seeded,
  now() - MAX(updated_at) AS age
FROM marta_stops
GROUP BY stop_type;

SELECT COUNT(*) AS poi_rows,
  MAX(last_synced) AS last_synced,
  now() - MAX(last_synced) AS poi_age
FROM pois;
```

---

## Index Strategy

| Index | Type | Column | Purpose |
|---|---|---|---|
| `idx_marta_stops_location` | GIST | `marta_stops.location` | ST_DWithin + KNN `<->` |
| `idx_marta_stops_type` | B-tree | `marta_stops.stop_type` | Filter rail vs bus |
| `idx_pois_location` | GIST | `pois.location` | POI spatial queries |
| `idx_pois_amenity` | B-tree | `pois.amenity` | Filter by category |
| `idx_pois_osm_id` | B-tree (partial) | `pois.osm_id WHERE NOT NULL` | Upsert conflict check |
| `idx_stop_times_stop` | B-tree | `(stop_id, departure_time)` | Schedule fallback query |
| `idx_route_stops_stop` | B-tree | `route_stops.stop_id` | Reverse route lookup + routing graph build |

**After bulk bus stop load, always run:**
```sql
CLUSTER marta_stops USING idx_marta_stops_location;
ANALYZE marta_stops;
```
This physically reorders rows by location, improving range scan locality for ST_DWithin.

---

## Common Mistakes

```sql
-- ❌ Wrong — lat/lon swapped, Atlanta appears in the ocean
ST_MakePoint(33.7488, -84.3765)

-- ✅ Correct — longitude first, latitude second
ST_MakePoint(-84.3765, 33.7488)

-- ❌ Wrong — full table scan for nearest stop
ORDER BY ST_Distance(location, pt)

-- ✅ Correct — GIST KNN index scan
ORDER BY location <-> pt

-- ❌ Wrong — GEOMETRY returns degrees, not meters
ST_Distance(location::GEOMETRY, pt::GEOMETRY)

-- ✅ Correct — GEOGRAPHY returns meters
ST_Distance(location, pt::GEOGRAPHY)
```

---

## Atlanta Reference Coordinates

```
King Memorial Station:   lat=33.7488,  lon=-84.3765
Five Points Station:     lat=33.7538,  lon=-84.3908
Mock user location:      lat=33.74976, lon=-84.37726
Atlanta city bbox:       SW(33.647,-84.551) → NE(33.957,-84.289)
```
