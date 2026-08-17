"""Phase 3 — eatery POIs from Overpass, tiled over the Atlanta bbox to stay under Overpass's
per-request element cap. Run AFTER rail + bus. Safe to re-run (upserts on osm_id)."""
import argparse
import io
import os

import psycopg2
import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
ATLANTA_BBOX = (33.647, -84.551, 33.957, -84.289)  # SW lat, SW lon, NE lat, NE lon
EATERY_AMENITIES = "restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|bakery|deli"
ALL_AMENITIES = EATERY_AMENITIES + "|pharmacy|bank|cinema|library|school|hospital"


def tile_bbox(bbox, n):
    """Split bbox into an n x n grid of (south, west, north, east) tiles."""
    south, west, north, east = bbox
    lat_step = (north - south) / n
    lon_step = (east - west) / n
    for i in range(n):
        for j in range(n):
            yield (
                south + i * lat_step,
                west + j * lon_step,
                south + (i + 1) * lat_step,
                west + (j + 1) * lon_step,
            )


def fetch_tile(bbox, amenities):
    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:60];
    (
      node["amenity"~"^({amenities})$"]({south},{west},{north},{east});
      way["amenity"~"^({amenities})$"]({south},{west},{north},{east});
    );
    out center;
    """
    resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=90)
    resp.raise_for_status()
    return resp.json()["elements"]


def seed_pois(conn, all_pois=False):
    amenities = ALL_AMENITIES if all_pois else EATERY_AMENITIES
    n = 3 if all_pois else 2
    total = 0

    with conn.cursor() as cur:
        for tile in tile_bbox(ATLANTA_BBOX, n):
            elements = fetch_tile(tile, amenities)

            cur.execute(
                """
                CREATE TEMP TABLE IF NOT EXISTS tmp_pois (
                  osm_id BIGINT, name TEXT, amenity TEXT, cuisine TEXT,
                  lon FLOAT, lat FLOAT, osm_tags JSONB
                )
                """
            )
            cur.execute("TRUNCATE tmp_pois")

            buf = io.StringIO()
            for el in elements:
                tags = el.get("tags", {})
                name = tags.get("name")
                if not name:
                    continue
                lat = el.get("lat") or el.get("center", {}).get("lat")
                lon = el.get("lon") or el.get("center", {}).get("lon")
                if lat is None or lon is None:
                    continue
                buf.write(f"{el['id']}\t{name}\t{tags.get('amenity','')}\t"
                          f"{tags.get('cuisine','')}\t{lon}\t{lat}\n")

            buf.seek(0)
            if buf.getvalue():
                cur.copy_expert(
                    "COPY tmp_pois (osm_id,name,amenity,cuisine,lon,lat) FROM STDIN "
                    "WITH (FORMAT text, NULL '')",
                    buf,
                )

            cur.execute(
                """
                INSERT INTO pois (osm_id, name, amenity, cuisine, location)
                SELECT osm_id, name, amenity, NULLIF(cuisine,''), ST_MakePoint(lon, lat)::GEOGRAPHY
                FROM tmp_pois
                ON CONFLICT (osm_id) DO UPDATE SET
                  name = EXCLUDED.name,
                  amenity = EXCLUDED.amenity,
                  cuisine = EXCLUDED.cuisine,
                  location = EXCLUDED.location,
                  last_synced = now()
                """
            )
            total += len(elements)
    conn.commit()
    print(f"[poi] seeded ~{total} POIs across {n * n} tiles")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL", "postgresql://localhost/skipper"))
    parser.add_argument("--all-pois", action="store_true")
    args = parser.parse_args()

    conn = psycopg2.connect(args.db)
    try:
        seed_pois(conn, all_pois=args.all_pois)
    finally:
        conn.close()
