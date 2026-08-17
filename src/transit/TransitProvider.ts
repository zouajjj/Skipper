// FROZEN — do not change these signatures. All adapters depend on this contract.
// See docs/transit-adapter.md before touching this file.

export interface StopArrival {
  stop_id: string;
  route_id: string;
  route_name: string;
  headsign: string;
  arrival_min: number;
  vehicle_id: string | null;
  status: 'scheduled' | 'realtime' | 'delayed' | 'cancelled';
  source: 'api' | 'cached';
}

export interface VehiclePosition {
  vehicle_id: string;
  route_id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  timestamp: number;
}

export interface TransitProvider {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly baseUrl: string;
  readonly requiresKey: boolean;

  getArrivals(stopId: string): Promise<StopArrival[]>;
  getVehicles?(routeId: string): Promise<VehiclePosition[]>;
  ping(): Promise<boolean>;
}
