"""Phase 1 — rail + streetcar stops. Safe to re-run anytime; GIST index stays live."""
import os

import psycopg2

CSV_PATH = os.path.join(os.path.dirname(__file__), "rail_stops_atlanta.csv")


def seed_rail(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TEMP TABLE tmp_rail (
              stop_id TEXT, name TEXT, stop_type TEXT, lon FLOAT, lat FLOAT, lines TEXT
            ) ON COMMIT DROP
            """
        )
        with open(CSV_PATH) as f:
            cur.copy_expert("COPY tmp_rail FROM STDIN WITH CSV HEADER", f)

        cur.execute(
            """
            INSERT INTO marta_stops (stop_id, name, stop_type, location, lines)
            SELECT stop_id, name, stop_type,
              ST_MakePoint(lon, lat)::GEOGRAPHY,
              string_to_array(trim(both '{}' from lines), ',')
            FROM tmp_rail
            ON CONFLICT (stop_id) DO UPDATE SET
              name = EXCLUDED.name,
              location = EXCLUDED.location,
              lines = EXCLUDED.lines,
              updated_at = now()
            """
        )
        cur.execute("SELECT COUNT(*) FROM tmp_rail")
        (count,) = cur.fetchone()
    conn.commit()
    print(f"[rail] seeded {count} rail/streetcar stops")


if __name__ == "__main__":
    db_url = os.environ.get("DATABASE_URL", "postgresql://localhost/skipper")
    conn = psycopg2.connect(db_url)
    try:
        seed_rail(conn)
    finally:
        conn.close()
