// Transit routing graph: rail line adjacency (marta_lines.stop_ids) + bus route adjacency
// (route_stops) + short walking transfers between nearby stops of different stop_type.
// Dijkstra over this graph replaces the old "nearest stop + straight line" stub in
// src/api/route-plan.ts. See docs/architecture.md "Data Flow — Route Plan Request".
import { query } from '../db';
import { haversineMiles } from '../utils/haversine';

const TRANSIT_MIN_PER_MILE = 3.8;
const WALK_MIN_PER_MILE = 20;
const MIN_RIDE_MIN = 2;
const TRANSFER_PENALTY_MIN = 4;
const WALK_TRANSFER_MAX_METERS = 150;

export interface GraphStop {
  stop_id: string;
  name: string;
  stop_type: string;
  lat: number;
  lon: number;
  platform_code: string | null;
}

export type EdgeMode = 'rail' | 'bus' | 'walk';

interface Edge {
  to: string;
  mode: EdgeMode;
  label: string; // line_id ('RED') or route_short_name ('7'); '' for walk transfers
  min: number;
}

export interface TransitGraph {
  stops: Map<string, GraphStop>;
  adjacency: Map<string, Edge[]>;
}

export interface RouteHop {
  from: string;
  to: string;
  mode: EdgeMode;
  label: string;
  min: number;
}

let cachedGraph: TransitGraph | null = null;

// Stops rarely change while the server is running (they're seeded, not written at request
// time), so the graph is built once and reused — rebuilding it from scratch on every
// route-plan request would mean re-querying every stop/line/route_stops row per call.
export async function getGraph(): Promise<TransitGraph> {
  if (!cachedGraph) cachedGraph = await buildGraph();
  return cachedGraph;
}

export function invalidateGraph(): void {
  cachedGraph = null;
}

async function buildGraph(): Promise<TransitGraph> {
  const stopsRes = await query<{
    stop_id: string;
    name: string;
    stop_type: string;
    lat: number;
    lon: number;
    platform_code: string | null;
  }>(
    `SELECT stop_id, name, stop_type, platform_code,
       ST_Y(location::GEOMETRY) AS lat, ST_X(location::GEOMETRY) AS lon
     FROM marta_stops`
  );

  const stops = new Map<string, GraphStop>();
  for (const row of stopsRes.rows) stops.set(row.stop_id, row);

  const adjacency = new Map<string, Edge[]>();
  const addEdge = (from: string, to: string, mode: EdgeMode, label: string, min: number) => {
    if (!stops.has(from) || !stops.has(to) || from === to) return;
    const list = adjacency.get(from) ?? [];
    list.push({ to, mode, label, min });
    adjacency.set(from, list);
  };

  const rideTime = (a: GraphStop, b: GraphStop) =>
    Math.max(MIN_RIDE_MIN, haversineMiles(a.lat, a.lon, b.lat, b.lon) * TRANSIT_MIN_PER_MILE);

  // Rail: consecutive stops within each line's ordered sequence, bidirectional.
  const linesRes = await query<{ line_id: string; stop_ids: string[] | null }>(
    `SELECT line_id, stop_ids FROM marta_lines`
  );
  for (const line of linesRes.rows) {
    const ids = line.stop_ids ?? [];
    for (let i = 0; i < ids.length - 1; i++) {
      const a = stops.get(ids[i]);
      const b = stops.get(ids[i + 1]);
      if (!a || !b) continue;
      const t = rideTime(a, b);
      addEdge(a.stop_id, b.stop_id, 'rail', line.line_id, t);
      addEdge(b.stop_id, a.stop_id, 'rail', line.line_id, t);
    }
  }

  // Bus: consecutive stops within each (route_id, direction_id) sequence, directed —
  // GTFS directions aren't symmetric, so unlike rail this is one-way per row order.
  const routeStopsRes = await query<{
    route_id: string;
    route_short_name: string;
    direction_id: number;
    stop_id: string;
    stop_sequence: number;
  }>(
    `SELECT route_id, route_short_name, direction_id, stop_id, stop_sequence
     FROM route_stops ORDER BY route_id, direction_id, stop_sequence`
  );

  let prevKey: string | null = null;
  let prevStopId: string | null = null;
  for (const row of routeStopsRes.rows) {
    const key = `${row.route_id}:${row.direction_id}`;
    if (key === prevKey && prevStopId) {
      const a = stops.get(prevStopId);
      const b = stops.get(row.stop_id);
      if (a && b) addEdge(a.stop_id, b.stop_id, 'bus', row.route_short_name, rideTime(a, b));
    }
    prevKey = key;
    prevStopId = row.stop_id;
  }

  // Walking transfers: short hops between nearby stops of a *different* stop_type (rail
  // platform to a bus bay outside, etc). Distance-derived, not a hardcoded station pair.
  const transferRes = await query<{ a: string; b: string; meters: number }>(
    `SELECT s1.stop_id AS a, s2.stop_id AS b, ST_Distance(s1.location, s2.location) AS meters
     FROM marta_stops s1
     JOIN marta_stops s2 ON s1.stop_id < s2.stop_id
       AND s1.stop_type <> s2.stop_type
       AND ST_DWithin(s1.location, s2.location, $1)`,
    [WALK_TRANSFER_MAX_METERS]
  );
  for (const row of transferRes.rows) {
    const walkMin = Math.max(1, (row.meters / 1609.34) * WALK_MIN_PER_MILE);
    addEdge(row.a, row.b, 'walk', '', walkMin);
    addEdge(row.b, row.a, 'walk', '', walkMin);
  }

  return { stops, adjacency };
}

/**
 * Dijkstra from several candidate boarding stops to several candidate alighting stops.
 * State is (stopId, currentEdgeMode) rather than just stopId, so a transfer penalty can be
 * charged when the line/route changes at a shared node — without that, the search couldn't
 * tell "still riding the Blue Line through Five Points" apart from "got off the Gold Line
 * and boarded the Blue Line at Five Points".
 */
export function findRoute(
  graph: TransitGraph,
  origins: { stopId: string; walkMin: number }[],
  dests: { stopId: string; walkMin: number }[]
): RouteHop[] | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, { stateKey: string; hop: RouteHop } | null>();
  const destWalk = new Map(dests.map((d) => [d.stopId, d.walkMin]));

  type QItem = { key: string; stopId: string; mode: string; d: number };
  const pq: QItem[] = [];

  for (const o of origins) {
    if (!graph.stops.has(o.stopId)) continue;
    const key = `${o.stopId}|START`;
    if (!dist.has(key) || o.walkMin < dist.get(key)!) {
      dist.set(key, o.walkMin);
      prev.set(key, null);
      pq.push({ key, stopId: o.stopId, mode: 'START', d: o.walkMin });
    }
  }

  const visited = new Set<string>();
  let bestEnd: { key: string; total: number } | null = null;

  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const cur = pq.shift()!;
    if (visited.has(cur.key)) continue;
    visited.add(cur.key);

    const dWalk = destWalk.get(cur.stopId);
    if (dWalk !== undefined) {
      const total = cur.d + dWalk;
      if (!bestEnd || total < bestEnd.total) bestEnd = { key: cur.key, total };
    }

    for (const e of graph.adjacency.get(cur.stopId) ?? []) {
      const edgeMode = e.mode === 'walk' ? 'WALK' : `${e.mode}:${e.label}`;
      const isTransfer =
        e.mode !== 'walk' && cur.mode !== 'START' && cur.mode !== 'WALK' && cur.mode !== edgeMode;
      const nd = cur.d + e.min + (isTransfer ? TRANSFER_PENALTY_MIN : 0);
      const nKey = `${e.to}|${edgeMode}`;
      if (!dist.has(nKey) || nd < dist.get(nKey)!) {
        dist.set(nKey, nd);
        prev.set(nKey, {
          stateKey: cur.key,
          hop: { from: cur.stopId, to: e.to, mode: e.mode, label: e.label, min: e.min },
        });
        pq.push({ key: nKey, stopId: e.to, mode: edgeMode, d: nd });
      }
    }
  }

  if (!bestEnd) return null;

  const hops: RouteHop[] = [];
  let k: string | null = bestEnd.key;
  while (k) {
    const p = prev.get(k);
    if (!p) break;
    hops.unshift(p.hop);
    k = p.stateKey;
  }
  return hops;
}
