import { StopArrival, TransitProvider } from '../TransitProvider';

export class TflAdapter implements TransitProvider {
  readonly agencyId = 'tfl';
  readonly agencyName = 'Transport for London';
  readonly baseUrl = 'https://api.tfl.gov.uk';
  readonly requiresKey = false;

  constructor(private appId?: string, private appKey?: string) {}

  private authQuery(): string {
    if (!this.appId || !this.appKey) return '';
    return `?app_id=${this.appId}&app_key=${this.appKey}`;
  }

  async getArrivals(stopId: string): Promise<StopArrival[]> {
    const res = await fetch(`${this.baseUrl}/StopPoint/${stopId}/Arrivals${this.authQuery()}`);
    if (!res.ok) throw new Error(`TfL feed returned ${res.status}`);
    const rows = (await res.json()) as any[];

    return rows.map((r) => ({
      stop_id: stopId,
      route_id: r.lineName,
      route_name: r.lineName,
      headsign: r.towards ?? r.destinationName,
      arrival_min: Math.round(r.timeToStation / 60),
      vehicle_id: r.vehicleId ?? null,
      status: 'realtime' as const,
      source: 'api' as const,
    }));
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/Line/Meta/Modes`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
