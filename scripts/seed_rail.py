"""Phase 1 — rail + streetcar stops. Safe to re-run anytime; GIST index stays live."""
import os

import psycopg2

CSV_PATH = os.path.join(os.path.dirname(__file__), "rail_stops_atlanta.csv")

# Ordered per-line stop sequences — same values as LINE_PATHS embedded in public/skipper.html,
# kept in sync there since the frontend has no build step to share a module. This is what
# route-plan.ts's routing graph walks for rail adjacency (marta_lines.stop_ids).
LINE_SEQUENCES = {
    "GREEN": ["BANKHEAD", "ASHBY", "VINE_CITY", "GWCC", "FIVE_PTS", "GEORGIA_ST", "KING", "INMAN_PARK", "EDGEWOOD"],
    "GOLD": [
        "DORAVILLE", "CHAMBLEE", "BROOKHAVEN", "LENOX", "LINDBERGH", "ARTS_CENTER", "MIDTOWN",
        "NORTH_AVE", "CIVIC_CENTER", "PEACHTREE_CENTER", "FIVE_PTS", "GARNETT", "WEST_END",
        "OAKLAND_CITY", "LAKEWOOD", "EAST_POINT", "COLLEGE_PARK", "AIRPORT",
    ],
    "BLUE": [
        "HAMILTON_E_HOLMES", "WEST_LAKE", "ASHBY", "VINE_CITY", "GWCC", "FIVE_PTS", "GEORGIA_ST",
        "KING", "INMAN_PARK", "EDGEWOOD", "EAST_LAKE", "DECATUR", "AVONDALE", "KENSINGTON", "INDIAN_CREEK",
    ],
    "RED": [
        "NORTH_SPRINGS", "SANDY_SPRINGS", "DUNWOODY", "MEDICAL_CENTER", "BUCKHEAD", "LINDBERGH",
        "ARTS_CENTER", "MIDTOWN", "NORTH_AVE", "CIVIC_CENTER", "PEACHTREE_CENTER", "FIVE_PTS",
        "GARNETT", "WEST_END", "OAKLAND_CITY", "LAKEWOOD", "EAST_POINT", "COLLEGE_PARK", "AIRPORT",
    ],
}

# Same values as LINE_CLR in public/skipper.html.
LINE_COLORS = {"RED": "#ef4444", "GOLD": "#f59e0b", "BLUE": "#3b82f6", "GREEN": "#22c55e"}


def seed_lines(conn):
    with conn.cursor() as cur:
        for line_id, stop_ids in LINE_SEQUENCES.items():
            cur.execute(
                """
                INSERT INTO marta_lines (line_id, line_name, color_hex, stop_ids)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (line_id) DO UPDATE SET
                  line_name = EXCLUDED.line_name,
                  color_hex = EXCLUDED.color_hex,
                  stop_ids = EXCLUDED.stop_ids
                """,
                (line_id, f"{line_id.title()} Line", LINE_COLORS[line_id], stop_ids),
            )
    conn.commit()
    print(f"[rail] seeded {len(LINE_SEQUENCES)} line topologies")


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
    seed_lines(conn)


if __name__ == "__main__":
    db_url = os.environ.get("DATABASE_URL", "postgresql://localhost/skipper")
    conn = psycopg2.connect(db_url)
    try:
        seed_rail(conn)
    finally:
        conn.close()
