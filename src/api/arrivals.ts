import { Router } from 'express';
import { getProvider } from '../transit/ProviderRegistry';
import { getCachedArrivals } from '../transit/ArrivalCache';
import { StopArrival } from '../transit/TransitProvider';
import { query } from '../db';

export const arrivalsRouter = Router();

// GET /api/arrivals?stop_id=KING&agency=marta
// The only place that touches TransitProvider. Frontend never calls transit APIs directly.
arrivalsRouter.get('/arrivals', async (req, res) => {
  const stopId = String(req.query.stop_id ?? '');
  const agency = String(req.query.agency ?? 'marta');
  if (!stopId) return res.status(400).json({ error: 'stop_id is required' });

  const provider = getProvider(agency);
  const alive = await provider.ping();

  let arrivals: StopArrival[];
  let source: 'api' | 'cached';

  if (alive) {
    arrivals = await getCachedArrivals(stopId, () => provider.getArrivals(stopId));
    source = 'api';
  } else {
    // No live schedule import exists in this scaffold (stop_times is seeded nowhere — see
    // "Next Sprint" in CLAUDE.md), so this can't report a real departure time. It can still
    // honestly report which routes serve the stop, from the topology seed_bus.py already
    // builds — better than the old query, which referenced trips/routes tables that don't
    // exist anywhere in schema.sql and threw a SQL error on every fallback request.
    const { rows } = await query(
      `SELECT DISTINCT route_id, route_short_name, headsign
       FROM route_stops
       WHERE stop_id = $1
       LIMIT 5`,
      [stopId]
    );
    arrivals = rows.map((r: any) => ({
      stop_id: stopId,
      route_id: r.route_id,
      route_name: r.route_short_name,
      headsign: r.headsign,
      arrival_min: 0, // StopArrival.arrival_min is frozen as non-nullable; no live schedule exists to derive a real value
      vehicle_id: null,
      status: 'scheduled',
      source: 'cached',
    }));
    source = 'cached';
  }

  res.json({ stop_id: stopId, agency, source, arrivals });
});
