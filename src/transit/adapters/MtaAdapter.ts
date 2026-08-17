import { StopArrival, TransitProvider } from '../TransitProvider';

export class MtaAdapter implements TransitProvider {
  readonly agencyId = 'mta';
  readonly agencyName = 'MTA';
  readonly baseUrl = 'https://bustime.mta.info';
  readonly requiresKey = true;

  constructor(private apiKey: string) {}

  async getArrivals(stopId: string): Promise<StopArrival[]> {
    const url = `${this.baseUrl}/api/siri/stop-monitoring.json?key=${this.apiKey}&MonitoringRef=${stopId}&MaximumStopVisits=5`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MTA feed returned ${res.status}`);
    const body = (await res.json()) as any;
    const visits =
      body?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit ?? [];

    return visits.map((v: any) => {
      const j = v.MonitoredVehicleJourney;
      const arrivalTime = j.MonitoredCall.ExpectedArrivalTime;
      return {
        stop_id: stopId,
        route_id: j.LineRef,
        route_name: j.PublishedLineName,
        headsign: j.DestinationName,
        arrival_min: Math.max(0, Math.round((new Date(arrivalTime).getTime() - Date.now()) / 60000)),
        vehicle_id: j.VehicleRef ?? null,
        status: 'realtime' as const,
        source: 'api' as const,
      };
    });
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/siri/stop-monitoring.json?key=${this.apiKey}&MonitoringRef=999999`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
