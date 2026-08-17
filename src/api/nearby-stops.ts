import { Router } from 'express';
import { query } from '../db';

export const nearbyStopsRouter = Router();

// GET /api/nearby-stops?lat=&lon=&radius=
nearbyStopsRouter.get('/nearby-stops', async (req, res) => {
  const lat = parseFloat(String(req.query.lat));
  const lon = parseFloat(String(req.query.lon));
  const radius = parseInt(String(req.query.radius ?? '1609'), 10);

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  // $1=lat, $2=lon, $3=radius_meters — ST_MakePoint($2,$1) is (lon,lat). Never swap.
  const { rows } = await query(
    `SELECT
       stop_id, name, stop_type, lines,
       ROUND((ST_Distance(location, ST_MakePoint($2,$1)::GEOGRAPHY) * 0.000621371)::numeric, 3) AS distance_miles
     FROM marta_stops
     WHERE ST_DWithin(location, ST_MakePoint($2,$1)::GEOGRAPHY, $3)
     ORDER BY location <-> ST_MakePoint($2,$1)::GEOGRAPHY
     LIMIT 5`,
    [lat, lon, radius]
  );

  res.json({ stops: rows });
});
