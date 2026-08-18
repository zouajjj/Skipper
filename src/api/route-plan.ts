import { Router } from 'express';
import { query } from '../db';
import { haversineMiles } from '../utils/haversine';
import { findRoute, getGraph, GraphStop, RouteHop } from '../routing/graph';

export const routePlanRouter = Router();

const WALK_MIN_PER_MILE = 20;
const CANDIDATE_STOP_LIMIT = 5;

interface StopRow {
  stop_id: string;
  name: string;
  stop_type: string;
  lat: number;
  lon: number;
}

interface Leg {
  type: 'walk' | 'ride';
  mode?: 'rail' | 'bus';
  label?: string;
  from: string;
  to: string;
  dist_mi?: number;
  min: number;
  stops?: number;
  from_platform?: string | null;
  estimated?: true;
}

async function nearestStops(lat: number, lon: number, limit: number): Promise<StopRow[]> {
  const { rows } = await query<StopRow>(
    `SELECT stop_id, name, stop_type,
       ST_Y(location::GEOMETRY) AS lat, ST_X(location::GEOMETRY) AS lon
     FROM marta_stops
     ORDER BY location <-> ST_MakePoint($2,$1)::GEOGRAPHY
     LIMIT $3`,
    [lat, lon, limit]
  );
  return rows;
}

// Collapse consecutive same-line/same-route hops into one "ride" leg, and consecutive
// walking-transfer hops into one "walk" leg — so a Gold->transfer->Blue path renders as two
// ride legs with a named transfer station between them, not one hop per station pair.
function collapseHops(hops: RouteHop[], stops: Map<string, GraphStop>): Leg[] {
  const legs: Leg[] = [];
  let i = 0;
  while (i < hops.length) {
    const head = hops[i];
    let j = i;
    while (j + 1 < hops.length && hops[j + 1].mode === head.mode && hops[j + 1].label === head.label) j++;

    const fromStop = stops.get(head.from)!;
    const toStop = stops.get(hops[j].to)!;
    const min = hops.slice(i, j + 1).reduce((sum, h) => sum + h.min, 0);

    if (head.mode === 'walk') {
      legs.push({
        type: 'walk',
        from: fromStop.name,
        to: toStop.name,
        dist_mi: round3(haversineMiles(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon)),
        min: Math.round(min),
      });
    } else {
      legs.push({
        type: 'ride',
        mode: head.mode,
        label: head.label,
        from: fromStop.name,
        to: toStop.name,
        min: Math.round(min),
        stops: j - i + 1,
        from_platform: fromStop.platform_code,
      });
    }
    i = j + 1;
  }
  return legs;
}

// POST /api/route-plan { user_location: {lat, lon}, poi: {lat, lon, name} }
routePlanRouter.post('/route-plan', async (req, res) => {
  const { user_location, poi } = req.body ?? {};
  if (!user_location?.lat || !user_location?.lon || !poi?.lat || !poi?.lon) {
    return res.status(400).json({ error: 'user_location and poi (each with lat/lon) are required' });
  }

  const [originCandidates, destCandidates] = await Promise.all([
    nearestStops(user_location.lat, user_location.lon, CANDIDATE_STOP_LIMIT),
    nearestStops(poi.lat, poi.lon, CANDIDATE_STOP_LIMIT),
  ]);
  if (!originCandidates.length || !destCandidates.length) {
    return res.status(404).json({ error: 'No seeded stops found — has the seed pipeline run?' });
  }

  const graph = await getGraph();
  const origins = originCandidates.map((s) => ({
    stopId: s.stop_id,
    walkMin: haversineMiles(user_location.lat, user_location.lon, s.lat, s.lon) * WALK_MIN_PER_MILE,
  }));
  const dests = destCandidates.map((s) => ({
    stopId: s.stop_id,
    walkMin: haversineMiles(poi.lat, poi.lon, s.lat, s.lon) * WALK_MIN_PER_MILE,
  }));

  const hops = findRoute(graph, origins, dests);

  if (hops && hops.length) {
    const rideLegs = collapseHops(hops, graph.stops);
    const boardStop = graph.stops.get(hops[0].from)!;
    const alightStop = graph.stops.get(hops[hops.length - 1].to)!;
    const w1 = haversineMiles(user_location.lat, user_location.lon, boardStop.lat, boardStop.lon);
    const w2 = haversineMiles(poi.lat, poi.lon, alightStop.lat, alightStop.lon);

    const legs: Leg[] = [
      { type: 'walk', from: 'Your Location', to: boardStop.name, dist_mi: round3(w1), min: Math.round(w1 * WALK_MIN_PER_MILE) },
      ...rideLegs,
      { type: 'walk', from: alightStop.name, to: poi.name ?? 'Destination', dist_mi: round3(w2), min: Math.round(w2 * WALK_MIN_PER_MILE) },
    ];

    return res.json({
      route_id: `${boardStop.stop_id}-${alightStop.stop_id}`,
      legs,
      total_minutes: legs.reduce((sum, leg) => sum + leg.min, 0),
      disclaimer: 'Times estimated from stop-to-stop distance along the seeded network — verify at itsmarta.com',
    });
  }

  // No connected path found in the graph (e.g. bus route_stops not seeded yet, or the two
  // stops genuinely aren't reachable on the network). Report a straight-line walking
  // estimate and say so plainly, instead of fabricating a "transit" leg that isn't real.
  const origin = originCandidates[0];
  const dest = destCandidates[0];
  const w1 = haversineMiles(user_location.lat, user_location.lon, origin.lat, origin.lon);
  const w2 = haversineMiles(poi.lat, poi.lon, dest.lat, dest.lon);
  const td = haversineMiles(origin.lat, origin.lon, dest.lat, dest.lon);

  const legs: Leg[] = [
    { type: 'walk', from: 'Your Location', to: origin.name, dist_mi: round3(w1), min: Math.round(w1 * WALK_MIN_PER_MILE) },
    { type: 'walk', from: origin.name, to: dest.name, dist_mi: round3(td), min: Math.round(td * WALK_MIN_PER_MILE), estimated: true },
    { type: 'walk', from: dest.name, to: poi.name ?? 'Destination', dist_mi: round3(w2), min: Math.round(w2 * WALK_MIN_PER_MILE) },
  ];

  res.json({
    route_id: `${origin.stop_id}-${dest.stop_id}`,
    legs,
    total_minutes: legs.reduce((sum, leg) => sum + leg.min, 0),
    estimated: true,
    disclaimer: 'No connected route found in the seeded transit network between these stops — this is a straight-line estimate, not a real ride.',
  });
});

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
