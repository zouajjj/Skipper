import express from 'express';
import path from 'path';
import { nearbyStopsRouter } from './api/nearby-stops';
import { routePlanRouter } from './api/route-plan';
import { arrivalsRouter } from './api/arrivals';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', nearbyStopsRouter);
app.use('/api', routePlanRouter);
app.use('/api', arrivalsRouter);

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'skipper.html'));
});

app.listen(PORT, () => {
  console.log(`Skipper listening on http://localhost:${PORT}`);
});
