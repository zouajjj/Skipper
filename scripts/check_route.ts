// Offline sanity check for the routing engine — no Postgres required.
//
// Runs the REAL routing algorithm (findRoute from src/routing/graph.ts, unmodified) against
// an in-memory graph built from the rail network data (scripts/rail_stops_atlanta.csv + the
// same LINE_SEQUENCES seed_rail.py writes into marta_lines). Rail only — bus route_stops only
// exist after a real GTFS seed against a live database, which this script deliberately
// doesn't require.
//
// Usage:
//   npx tsx scripts/check_route.ts --from 33.74999,-84.37706 --to 33.8467,-84.3623
//   npx tsx scripts/check_route.ts --from <user lat,lon> --to <poi lat,lon>
import fs from 'fs';
import path from 'path';
import { findRoute, TransitGraph, GraphStop } from '../src/routing/graph';
import { haversineMiles } from '../src/utils/haversine';

const WALK_MIN_PER_MILE = 20;
const CANDIDATE_LIMIT = 4;

// Same ordered per-line sequences seed_rail.py writes into marta_lines.stop_ids (and the
// same values as LINE_PATHS in public/skipper.html) — see scripts/seed_rail.py.
const LINE_SEQUENCES: Record<string, string[]> = {
  GREEN: ['BANKHEAD', 'ASHBY', 'VINE_CITY', 'GWCC', 'FIVE_PTS', 'GEORGIA_ST', 'KING', 'INMAN_PARK', 'EDGEWOOD'],
  GOLD: [
    'DORAVILLE', 'CHAMBLEE', 'BROOKHAVEN', 'LENOX', 'LINDBERGH', 'ARTS_CENTER', 'MIDTOWN',
    'NORTH_AVE', 'CIVIC_CENTER', 'PEACHTREE_CENTER', 'FIVE_PTS', 'GARNETT', 'WEST_END',
    'OAKLAND_CITY', 'LAKEWOOD', 'EAST_POINT', 'COLLEGE_PARK', 'AIRPORT',
  ],
  BLUE: [
    'HAMILTON_E_HOLMES', 'WEST_LAKE', 'ASHBY', 'VINE_CITY', 'GWCC', 'FIVE_PTS', 'GEORGIA_ST',
    'KING', 'INMAN_PARK', 'EDGEWOOD', 'EAST_LAKE', 'DECATUR', 'AVONDALE', 'KENSINGTON', 'INDIAN_CREEK',
  ],
  RED: [
    'NORTH_SPRINGS', 'SANDY_SPRINGS', 'DUNWOODY', 'MEDICAL_CENTER', 'BUCKHEAD', 'LINDBERGH',
    'ARTS_CENTER', 'MIDTOWN', 'NORTH_AVE', 'CIVIC_CENTER', 'PEACHTREE_CENTER', 'FIVE_PTS',
    'GARNETT', 'WEST_END', 'OAKLAND_CITY', 'LAKEWOOD', 'EAST_POINT', 'COLLEGE_PARK', 'AIRPORT',
  ],
};

function loadStops(): Map<string, GraphStop> {
  const csvPath = path.join(__dirname, 'rail_stops_atlanta.csv');
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const [header, ...rows] = lines;
  const cols = header.split(',');
  const stops = new Map<string, GraphStop>();
  for (const row of rows) {
    const values = row.split(',');
    const rec: Record<string, string> = {};
    cols.forEach((c, i) => (rec[c] = values[i]));
    stops.set(rec.stop_id, {
      stop_id: rec.stop_id,
      name: rec.name,
      stop_type: rec.stop_type,
      lat: parseFloat(rec.lat),
      lon: parseFloat(rec.lon),
      platform_code: null,
    });
  }
  return stops;
}

function buildRailOnlyGraph(): TransitGraph {
  const stops = loadStops();
  const adjacency = new Map<string, { to: string; mode: 'rail'; label: string; min: number }[]>();
  const addEdge = (from: string, to: string, label: string, min: number) => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, mode: 'rail', label, min });
    adjacency.set(from, list);
  };
  for (const [line, ids] of Object.entries(LINE_SEQUENCES)) {
    for (let i = 0; i < ids.length - 1; i++) {
      const a = stops.get(ids[i]);
      const b = stops.get(ids[i + 1]);
      if (!a || !b) continue;
      const min = Math.max(2, haversineMiles(a.lat, a.lon, b.lat, b.lon) * 3.8);
      addEdge(a.stop_id, b.stop_id, line, min);
      addEdge(b.stop_id, a.stop_id, line, min);
    }
  }
  return { stops, adjacency: adjacency as TransitGraph['adjacency'] };
}

function nearestStops(graph: TransitGraph, lat: number, lon: number, limit: number) {
  return [...graph.stops.values()]
    .map((s) => ({ s, d: haversineMiles(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ s, d }) => ({ stopId: s.stop_id, walkMin: d * WALK_MIN_PER_MILE, dist: d }));
}

function parseLatLon(arg: string): { lat: number; lon: number } {
  const [lat, lon] = arg.split(',').map(Number);
  if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error(`Bad "lat,lon" value: ${arg}`);
  return { lat, lon };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const fromArg = get('--from');
  const toArg = get('--to');
  if (!fromArg || !toArg) {
    console.error('Usage: npx tsx scripts/check_route.ts --from lat,lon --to lat,lon');
    process.exit(1);
  }
  const from = parseLatLon(fromArg!);
  const to = parseLatLon(toArg!);

  const graph = buildRailOnlyGraph();
  const origins = nearestStops(graph, from.lat, from.lon, CANDIDATE_LIMIT);
  const dests = nearestStops(graph, to.lat, to.lon, CANDIDATE_LIMIT);

  console.log(`From (${from.lat}, ${from.lon}) — nearest stations: ${origins.map((o) => `${graph.stops.get(o.stopId)!.name} (${o.dist.toFixed(2)}mi)`).join(', ')}`);
  console.log(`To   (${to.lat}, ${to.lon}) — nearest stations: ${dests.map((d) => `${graph.stops.get(d.stopId)!.name} (${d.dist.toFixed(2)}mi)`).join(', ')}`);
  console.log('');

  const hops = findRoute(graph, origins, dests);
  if (!hops || !hops.length) {
    console.log('No connected rail route found between these points.');
    return;
  }

  console.log(`Board at ${graph.stops.get(hops[0].from)!.name}, alight at ${graph.stops.get(hops[hops.length - 1].to)!.name}`);

  console.log('\nFull station-by-station path:');
  console.log(`  ${graph.stops.get(hops[0].from)!.name}`);
  for (const h of hops) {
    console.log(`  -> [${h.label}, ~${Math.round(h.min)} min] ${graph.stops.get(h.to)!.name}`);
  }

  console.log('\nCollapsed ride legs:');
  let totalMin = 0;
  let i = 0;
  let prevLabel: string | null = null;
  while (i < hops.length) {
    const head = hops[i];
    let j = i;
    while (j + 1 < hops.length && hops[j + 1].label === head.label) j++;
    const min = hops.slice(i, j + 1).reduce((s, h) => s + h.min, 0);
    totalMin += min;
    const transferNote = prevLabel !== null && prevLabel !== head.label ? '  <- transfer' : '';
    console.log(
      `  [${head.label}] ${graph.stops.get(head.from)!.name} -> ${graph.stops.get(hops[j].to)!.name}` +
        ` (${j - i + 1} stop${j - i === 0 ? '' : 's'}, ~${Math.round(min)} min)${transferNote}`
    );
    prevLabel = head.label;
    i = j + 1;
  }
  console.log(`Ride time: ~${Math.round(totalMin)} min (plus walk to/from stations)`);
}

main();
