"""Orchestrator — runs seed phases in order. Never reorder: rail is the FK anchor,
bus rebuilds the GIST index, POIs depend on neither but conventionally run last."""
import argparse
import os

import psycopg2

from seed_bus import seed_bus
from seed_pois import seed_pois
from seed_rail import seed_rail

PHASES = ("rail", "bus", "poi")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL", "postgresql://localhost/skipper"))
    parser.add_argument("--phases", nargs="+", choices=PHASES, default=list(PHASES))
    parser.add_argument("--all-pois", action="store_true")
    args = parser.parse_args()

    ordered = [p for p in PHASES if p in args.phases]
    conn = psycopg2.connect(args.db)
    try:
        for phase in ordered:
            if phase == "rail":
                seed_rail(conn)
            elif phase == "bus":
                seed_bus(conn)
            elif phase == "poi":
                seed_pois(conn, all_pois=args.all_pois)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
