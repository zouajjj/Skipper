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
    const { rows } = await query(
      `SELECT st.departure_time, t.route_id, r.route_short_name, t.trip_headsign
       FROM stop_times st
       JOIN trips t ON t.trip_id = st.trip_id
       JOIN routes r ON r.route_id = t.route_id
       WHERE st.stop_id = $1 AND st.departure_time > (NOW()::TIME)
       ORDER BY st.departure_time
       LIMIT 5`,
      [stopId]
    );
    arrivals = rows.map((r: any) => ({
      stop_id: stopId,
      route_id: r.route_id,
      route_name: r.route_short_name,
      headsign: r.trip_headsign,
      arrival_min: 0,
      vehicle_id: null,
      status: 'scheduled',
      source: 'cached',
    }));
    source = 'cached';
  }

  res.json({ stop_id: stopId, agency, source, arrivals });
});
