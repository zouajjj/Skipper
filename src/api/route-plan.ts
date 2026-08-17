import { Router } from 'express';
import { query } from '../db';
import { haversineMiles } from '../utils/haversine';

export const routePlanRouter = Router();

interface StopRow {
  stop_id: string;
  name: string;
  lines: string[];
  stop_type: string;
  lat: number;
  lon: number;
}

async function nearestStop(lat: number, lon: number): Promise<StopRow | null> {
  const { rows } = await query<StopRow>(
    `SELECT stop_id, name, lines, stop_type,
       ST_Y(location::GEOMETRY) AS lat, ST_X(location::GEOMETRY) AS lon
     FROM marta_stops
     ORDER BY location <-> ST_MakePoint($2,$1)::GEOGRAPHY
     LIMIT 1`,
    [lat, lon]
  );
  return rows[0] ?? null;
}

// POST /api/route-plan { user_location: {lat, lon}, poi: {lat, lon, name} }
routePlanRouter.post('/route-plan', async (req, res) => {
  const { user_location, poi } = req.body ?? {};
  if (!user_location?.lat || !user_location?.lon || !poi?.lat || !poi?.lon) {
    return res.status(400).json({ error: 'user_location and poi (each with lat/lon) are required' });
  }

  const origin = await nearestStop(user_location.lat, user_location.lon);
  const dest = await nearestStop(poi.lat, poi.lon);
  if (!origin || !dest) {
    return res.status(404).json({ error: 'No seeded stops found — has the seed pipeline run?' });
  }

  // Walk speed: 20 min/mile (3 mph). Transit speed: ~3.8 min/mile including stops.
  const w1 = haversineMiles(user_location.lat, user_location.lon, origin.lat, origin.lon);
  const w2 = haversineMiles(poi.lat, poi.lon, dest.lat, dest.lon);
  const td = haversineMiles(origin.lat, origin.lon, dest.lat, dest.lon);

  const legs = [
    { type: 'walk', from: 'Your Location', to: origin.name, dist_mi: round3(w1), min: Math.round(w1 * 20) },
    {
      type: 'transit',
      from: origin.name,
      to: dest.name,
      dist_mi: round3(td),
      min: Math.max(2, Math.round(td * 3.8)),
      lines: origin.lines,
    },
    { type: 'walk', from: dest.name, to: poi.name ?? 'Destination', dist_mi: round3(w2), min: Math.round(w2 * 20) },
  ];

  res.json({
    route_id: `${origin.stop_id}-${dest.stop_id}`,
    legs,
    total_minutes: legs.reduce((sum, leg) => sum + leg.min, 0),
    disclaimer: 'Times estimated from cached schedule — verify at itsmarta.com',
  });
});

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
