-- Run once as superuser
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

CREATE TABLE IF NOT EXISTS marta_stops (
  stop_id       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  stop_type     TEXT NOT NULL CHECK (stop_type IN ('rail','bus','streetcar')),
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  lines         TEXT[],
  gtfs_stop_id  TEXT,
  platform_code TEXT,                  -- bay/platform label, only if the GTFS feed supplies one
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marta_stops_location ON marta_stops USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_marta_stops_type     ON marta_stops (stop_type);

CREATE TABLE IF NOT EXISTS marta_lines (
  line_id    TEXT PRIMARY KEY,
  line_name  TEXT NOT NULL,
  color_hex  TEXT NOT NULL,
  route      GEOGRAPHY(LINESTRING, 4326),
  stop_ids   TEXT[]
);

CREATE TABLE IF NOT EXISTS pois (
  poi_id      BIGSERIAL PRIMARY KEY,
  osm_id      BIGINT UNIQUE,
  name        TEXT NOT NULL,
  amenity     TEXT NOT NULL,
  cuisine     TEXT,
  location    GEOGRAPHY(POINT, 4326) NOT NULL,
  address     TEXT,
  phone       TEXT,
  website     TEXT,
  osm_tags    JSONB,
  last_synced TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pois_location ON pois USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_pois_amenity  ON pois (amenity);
CREATE INDEX IF NOT EXISTS idx_pois_osm_id   ON pois (osm_id) WHERE osm_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS route_cache (
  cache_key     TEXT PRIMARY KEY,
  origin_stop   TEXT REFERENCES marta_stops(stop_id),
  dest_stop     TEXT REFERENCES marta_stops(stop_id),
  legs          JSONB NOT NULL,
  total_minutes INT,
  cached_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stop_times (
  trip_id        TEXT NOT NULL,
  stop_id        TEXT NOT NULL,
  stop_sequence  INT NOT NULL,
  arrival_time   INTERVAL,
  departure_time INTERVAL,
  PRIMARY KEY (trip_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times (stop_id, departure_time);

-- Canonical ordered stop sequence per bus route+direction. One representative trip per
-- (route_id, direction_id) — not the full GTFS schedule — enough for graph routing without
-- importing millions of stop_times rows. See docs/seeding.md Phase 2.
CREATE TABLE IF NOT EXISTS route_stops (
  route_id         TEXT NOT NULL,
  route_short_name TEXT NOT NULL,
  direction_id     INT NOT NULL,
  headsign         TEXT,
  stop_id          TEXT NOT NULL REFERENCES marta_stops(stop_id),
  stop_sequence    INT NOT NULL,
  PRIMARY KEY (route_id, direction_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS idx_route_stops_stop ON route_stops (stop_id);
