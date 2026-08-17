import { StopArrival, TransitProvider, VehiclePosition } from '../TransitProvider';

// Generic adapter for any agency publishing standard GTFS-RT protobuf feeds.
// Requires `npm install gtfs-realtime-bindings` — not a base dependency since
// most cities use one of the named adapters instead.
export class GtfsRtAdapter implements TransitProvider {
  readonly requiresKey: boolean;

  constructor(
    public readonly agencyId: string,
    public readonly agencyName: string,
    public readonly baseUrl: string,
    private apiKey?: string
  ) {
    this.requiresKey = Boolean(apiKey);
  }

  private async fetchFeed(path: string): Promise<any> {
    const { transit_realtime } = await import('gtfs-realtime-bindings');
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
    });
    if (!res.ok) throw new Error(`${this.agencyId} GTFS-RT feed returned ${res.status}`);
    const buffer = new Uint8Array(await res.arrayBuffer());
    return transit_realtime.FeedMessage.decode(buffer);
  }

  async getArrivals(stopId: string): Promise<StopArrival[]> {
    const feed = await this.fetchFeed('/trip-updates');
    const arrivals: StopArrival[] = [];

    for (const entity of feed.entity ?? []) {
      const tripUpdate = entity.tripUpdate;
      if (!tripUpdate) continue;
      for (const stu of tripUpdate.stopTimeUpdate ?? []) {
        if (stu.stopId !== stopId) continue;
        const arrivalTime = stu.arrival?.time ? Number(stu.arrival.time) * 1000 : null;
        arrivals.push({
          stop_id: stopId,
          route_id: tripUpdate.trip?.routeId ?? 'unknown',
          route_name: tripUpdate.trip?.routeId ?? 'unknown',
          headsign: '',
          arrival_min: arrivalTime ? Math.max(0, Math.round((arrivalTime - Date.now()) / 60000)) : 0,
          vehicle_id: tripUpdate.vehicle?.id ?? null,
          status: 'realtime',
          source: 'api',
        });
      }
    }
    return arrivals;
  }

  async getVehicles(routeId: string): Promise<VehiclePosition[]> {
    const feed = await this.fetchFeed('/vehicle-positions');
    const positions: VehiclePosition[] = [];

    for (const entity of feed.entity ?? []) {
      const v = entity.vehicle;
      if (!v || v.trip?.routeId !== routeId || !v.position) continue;
      positions.push({
        vehicle_id: v.vehicle?.id ?? entity.id,
        route_id: routeId,
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: v.position.bearing ?? null,
        timestamp: v.timestamp ? Number(v.timestamp) : Math.floor(Date.now() / 1000),
      });
    }
    return positions;
  }

  async ping(): Promise<boolean> {
    try {
      await this.fetchFeed('/trip-updates');
      return true;
    } catch {
      return false;
    }
  }
}
