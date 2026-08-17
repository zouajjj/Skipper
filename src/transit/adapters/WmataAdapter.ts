import { StopArrival, TransitProvider } from '../TransitProvider';

function normalizeMin(raw: string): number {
  if (raw === 'ARR' || raw === 'BRD') return 0;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export class WmataAdapter implements TransitProvider {
  readonly agencyId = 'wmata';
  readonly agencyName = 'WMATA';
  readonly baseUrl = 'https://api.wmata.com';
  readonly requiresKey = true;

  constructor(private apiKey: string) {}

  async getArrivals(stopId: string): Promise<StopArrival[]> {
    const res = await fetch(`${this.baseUrl}/StationPrediction.svc/json/GetPrediction/${stopId}`, {
      headers: { api_key: this.apiKey },
    });
    if (!res.ok) throw new Error(`WMATA feed returned ${res.status}`);
    const { Trains } = (await res.json()) as { Trains: any[] };

    return Trains.map((t) => ({
      stop_id: stopId,
      route_id: t.Line,
      route_name: `${t.Line} Line`,
      headsign: t.DestinationName,
      arrival_min: normalizeMin(t.Min),
      vehicle_id: null,
      status: 'realtime' as const,
      source: 'api' as const,
    }));
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/StationPrediction.svc/json/GetPrediction/All`, {
        headers: { api_key: this.apiKey },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
