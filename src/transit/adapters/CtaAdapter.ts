import { StopArrival, TransitProvider, VehiclePosition } from '../TransitProvider';

export class CtaAdapter implements TransitProvider {
  readonly agencyId = 'cta';
  readonly agencyName = 'CTA';
  readonly baseUrl = 'https://lapi.transitchicago.com/api/1.0';
  readonly requiresKey = true;

  constructor(private apiKey: string) {}

  async getArrivals(stopId: string): Promise<StopArrival[]> {
    const url = `${this.baseUrl}/ttarrivals.aspx?key=${this.apiKey}&mapid=${stopId}&outputType=JSON`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CTA feed returned ${res.status}`);
    const { ctatt } = (await res.json()) as any;

    return (ctatt.eta ?? []).map((e: any) => ({
      stop_id: stopId,
      route_id: e.rt,
      route_name: `${e.rt} Line`,
      headsign: e.destNm,
      arrival_min: Math.max(0, Math.round((new Date(e.arrT).getTime() - Date.now()) / 60000)),
      vehicle_id: e.vid ?? null,
      status: (e.isDly === '1' ? 'delayed' : 'realtime') as StopArrival['status'],
      source: 'api' as const,
    }));
  }

  async getVehicles(routeId: string): Promise<VehiclePosition[]> {
    const url = `${this.baseUrl}/ttpositions.aspx?key=${this.apiKey}&rt=${routeId}&outputType=JSON`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CTA feed returned ${res.status}`);
    const { ctatt } = (await res.json()) as any;
    const trains = ctatt.route?.[0]?.train ?? [];

    return trains.map((t: any) => ({
      vehicle_id: t.rn,
      route_id: routeId,
      lat: parseFloat(t.lat),
      lon: parseFloat(t.lon),
      bearing: t.heading != null ? parseFloat(t.heading) : null,
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/ttarrivals.aspx?key=${this.apiKey}&mapid=40380&outputType=JSON`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
