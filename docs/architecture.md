# Architecture

## System Overview

Skipper is a three-layer system. Each layer can operate independently — the frontend works
offline with Haversine, the backend works without real-time enrichment, and the transit adapter
enriches but never gates the route plan.

```
┌─────────────────────────────────────────────────────────┐
│  PWA Frontend (public/skipper.html)                     │
│  · Haversine distance math (offline, no quota)          │
│  · Overpass/OSM eatery fetch (no key)                   │
│  · Canvas MARTA rail map (34 stations hardcoded)        │
│  · "Open in Maps" deep-link (system native)             │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP
┌────────────────────▼────────────────────────────────────┐
│  Backend API (Node/Express)                             │
│  · GET /api/nearby-stops   → PostGIS ST_DWithin         │
│  · POST /api/route-plan    → PostGIS KNN + leg assembly │
│  · GET /api/arrivals       → TransitProvider adapter    │
└──────────┬──────────────────────────┬───────────────────┘
           │ pg                       │ fetch()
┌──────────▼──────────┐  ┌───────────▼───────────────────┐
│  PostGIS Database   │  │  Transit Provider (1 of N)    │
│  · marta_stops      │  │  · MartaAdapter (keyless)     │
│  · pois             │  │  · WmataAdapter (key req'd)   │
│  · marta_lines      │  │  · CtaAdapter  (key req'd)   │
│  · route_cache      │  │  · MtaAdapter  (key req'd)   │
│  · stop_times       │  │  · TflAdapter  (keyless)      │
└─────────────────────┘  └───────────────────────────────┘
```

---

## Data Flow — Route Plan Request

```
1. User shares location (GPS or mock: 33.74976, -84.37726)
        │
2. Frontend: Haversine → nearest seeded stop (client-side)
        │
3. User selects POI (eatery or McDonald's)
        │
4. POST /api/route-plan { user_location, poi_id }
        │
5. Backend queries PostGIS:
   · Nearest stop to user     → ST_MakePoint(lon,lat) <-> GIST
   · Nearest stop to POI      → same KNN query
   · Shared route feasibility → stop_times JOIN
        │
6. Legs assembled: [ walk → board → transit → alight → walk ]
        │
7. Arrival enrichment (optional):
   · provider.ping() → alive?
     · YES → provider.getArrivals(stop_id) → StopArrival[]
     · NO  → SELECT from stop_times → StopArrival[] (source:'cached')
        │
8. Response: { route_id, legs[], arrivals[], source, disclaimer }
```

---

## Data Flow — Seed Pipeline

```
Phase 1: rail_stops_atlanta.csv
  → COPY into tmp_rail (temp table)
  → INSERT INTO marta_stops ON CONFLICT DO UPDATE
  → GIST index untouched (38 rows, negligible)
  → ~0.3s

Phase 2: MARTA GTFS google_transit.zip → stops.txt
  → DROP INDEX idx_marta_stops_location
  → COPY into tmp_bus
  → INSERT INTO marta_stops (stop_type='bus')
  → CREATE INDEX idx_marta_stops_location USING GIST
  → CLUSTER marta_stops USING idx_marta_stops_location
  → ANALYZE marta_stops
  → ~4s (Atlanta ~7,000 bus stops)

Phase 3: Overpass API (tiled 2×2 quadrants over Atlanta bbox)
  → COPY each tile into tmp_pois
  → INSERT INTO pois ON CONFLICT (osm_id) DO UPDATE
  → ~23s (Atlanta ~4,500 eateries)
```

---

## Decision Log

### Why Haversine instead of Mapbox Distance Matrix?
Mapbox has a 25K req/month free tier and requires a network call. Haversine is in-browser,
instant, works offline, and has ~0.3% error — acceptable for transit stop proximity in Atlanta.
Mapbox would only be justified if road-accurate distance (accounting for rivers, highways, etc.)
were a product requirement, which it isn't in this sprint.

### Why GEOGRAPHY type instead of GEOMETRY?
GEOGRAPHY stores WGS84 lat/lon and returns ST_Distance in meters using the geodetic model.
GEOMETRY is faster but requires choosing a local CRS (EPSG:2240 for Georgia). For Atlanta's
~50mi transit footprint, the geodetic model is accurate enough and removes a projection step.

### Why drop/rebuild GIST index during bus stop seed?
For ~7,000 rows, PostgreSQL's incremental GIST updates during INSERT are ~3× slower than
rebuilding the entire index after the load. The window where the index is absent is ~2 seconds
and is safe because the backend is not serving spatial queries during seed.

### Why Overpass instead of Google Places for POIs?
Google Places Nearby Search costs $35/CPM on the Advanced tier. Overpass is free, requires no
API key, returns OSM data with sufficient Atlanta restaurant coverage, and the PWA already
fetches Overpass in the browser for eatery discovery. The nightly `sync_pois.py` cron replaces
per-request Overpass fetches with a pre-indexed PostGIS table.

### Why proxy transit API calls through `/api/arrivals`?
API keys must never appear in the PWA frontend (they would be visible in browser DevTools).
All five transit adapters require keys (except MARTA and TfL). The backend proxy is the
only place that reads `process.env.*_API_KEY`.

### Why a `TransitProvider` interface instead of direct API calls?
Adding a new city should require writing one adapter file and one line in `ProviderRegistry.ts`.
Without the interface, adding Chicago CTA would require touching the route plan, the arrivals
endpoint, the frontend, and the tests. The interface enforces the contract that routing logic
and transit APIs are decoupled.

### Why `ON CONFLICT DO UPDATE` on every seed INSERT?
Seeds run on deploy, on GTFS release, and on cron. Making them idempotent means a failed seed
mid-run can be retried without cleanup. It also means running the seed against a populated
database (e.g. after a schema migration) is safe.

---

## What This Is Not

- Not a turn-by-turn navigation app — the "Open in Maps" deep-link hands off final walking legs
  to the system maps app.
- Not a real-time vehicle tracker — vehicle positions are a stretch feature, not in scope for
  the current sprint.
- Not a multi-city app yet — the schema is city-agnostic but the seed scripts and mock
  coordinates are Atlanta-only. City onboarding is documented in `docs/seeding.md`.
