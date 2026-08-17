# Skipper — Init

Getting-started guide for the scaffold. For architecture and decisions, read `CLAUDE.md` and
`docs/` first — this file is just the "how do I run it" cheat sheet.

---

## 0. Try it with zero setup

The frontend works standalone, no backend or database required:

```bash
open public/skipper.html      # macOS
start public/skipper.html     # Windows
```

Click **"Use demo coordinates"** — it drops you at the mock location (near King Memorial
Station) and pulls live eatery data from Overpass/OSM. This is the fastest way to see the
product. Everything below wires up the real backend + PostGIS.

---

## 1. Install dependencies

```bash
npm install                                  # backend (Express, pg, TypeScript)
pip install -r scripts/requirements.txt      # seed pipeline (psycopg2, requests)
```

## 2. Database

Requires PostgreSQL 16+ with PostGIS 3.4+.

```bash
createdb skipper
psql skipper < scripts/schema.sql
```

## 3. Configure environment

```bash
cp .env.example .env
```

`DATABASE_URL` is the only required value. Transit adapter keys (`WMATA_API_KEY`, etc.) are
optional — MARTA needs no key, and unconfigured adapters simply won't be selectable until keyed.

## 4. Seed the database

Always in order: **rail → bus → POIs**. See `docs/seeding.md` for why.

```bash
# Full Atlanta seed (~27s)
python scripts/run_seed.py --db postgresql://localhost/skipper

# Rail only — fast, safe to re-run anytime
python scripts/run_seed.py --phases rail
```

## 5. Run the backend

```bash
npm run dev
```

Serves the API on `http://localhost:3000` and the PWA at `http://localhost:3000/`.

- `GET /api/nearby-stops?lat=&lon=&radius=`
- `POST /api/route-plan` — `{ user_location: {lat,lon}, poi: {lat,lon,name} }`
- `GET /api/arrivals?stop_id=KING&agency=marta`

## 6. Verify

```bash
curl "http://localhost:3000/api/nearby-stops?lat=33.74976&lon=-84.37726&radius=1609"
curl "http://localhost:3000/api/arrivals?stop_id=KING&agency=marta"
```

---

## What's scaffolded vs. what's next

| Layer | State |
|---|---|
| `TransitProvider` interface + 5 adapters | Implemented per `docs/transit-adapter.md` |
| `ArrivalCache` (30s TTL) | Implemented |
| `/api/nearby-stops`, `/api/route-plan`, `/api/arrivals` | Implemented, wired to PostGIS |
| Seed pipeline (rail/bus/POI) | Implemented, idempotent, ordered |
| `public/skipper.html` | Full standalone PWA — works with or without the backend |
| `route_cache` TTL reuse | Not wired — `route-plan` recomputes every request |
| Nightly `sync_pois.py` cron | Not scheduled — POIs seed on demand via `run_seed.py --phases poi` |
| Live vehicle positions | Adapters expose `getVehicles()`; nothing renders it yet |

Pick up from the **Next Sprint** list in `CLAUDE.md`.
