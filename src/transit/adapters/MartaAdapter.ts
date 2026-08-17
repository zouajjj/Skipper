import { StopArrival, TransitProvider, VehiclePosition } from '../TransitProvider';

const RAIL_URL = 'https://developer.itsmarta.com/RealtimeTrain/RestServiceNextTrain/GetRealtimeArrivals';
const BUS_URL = 'https://developer.itsmarta.com/BRDRestService/RestBusRealTimeService/GetAllBus';

// MARTA's API returns full station names; our schema keys on short codes.
const STATION_TO_STOP_ID: Record<string, string> = {
  'KING MEMORIAL': 'KING',
  'FIVE POINTS': 'FIVE_PTS',
  'GEORGIA STATE': 'GEORGIA_ST',
  'NORTH SPRINGS': 'NORTH_SPRINGS',
  'SANDY SPRINGS': 'SANDY_SPRINGS',
  DUNWOODY: 'DUNWOODY',
  'MEDICAL CENTER': 'MEDICAL_CENTER',
  BUCKHEAD: 'BUCKHEAD',
  'LINDBERGH CENTER': 'LINDBERGH',
  LENOX: 'LENOX',
  'BROOKHAVEN/OGLETHORPE UNIVERSITY': 'BROOKHAVEN',
  CHAMBLEE: 'CHAMBLEE',
  DORAVILLE: 'DORAVILLE',
  'ARTS CENTER': 'ARTS_CENTER',
  MIDTOWN: 'MIDTOWN',
  'NORTH AVE': 'NORTH_AVE',
  'CIVIC CENTER': 'CIVIC_CENTER',
  'PEACHTREE CENTER': 'PEACHTREE_CENTER',
  GARNETT: 'GARNETT',
  'WEST END': 'WEST_END',
  'OAKLAND CITY': 'OAKLAND_CITY',
  'LAKEWOOD/FT. MCPHERSON': 'LAKEWOOD',
  'EAST POINT': 'EAST_POINT',
  'COLLEGE PARK': 'COLLEGE_PARK',
  AIRPORT: 'AIRPORT',
  'H.E. HOLMES': 'HAMILTON_E_HOLMES',
  'WEST LAKE': 'WEST_LAKE',
  ASHBY: 'ASHBY',
  'VINE CITY': 'VINE_CITY',
  'DOME/GWCC/PHILIPS ARENA/CNN CENTER': 'GWCC',
  BANKHEAD: 'BANKHEAD',
  'INMAN PARK/REYNOLDSTOWN': 'INMAN_PARK',
  'EDGEWOOD/CANDLER PARK': 'EDGEWOOD',
  'EAST LAKE': 'EAST_LAKE',
  DECATUR: 'DECATUR',
  AVONDALE: 'AVONDALE',
  KENSINGTON: 'KENSINGTON',
  'INDIAN CREEK': 'INDIAN_CREEK',
};

function normalizeWaitingTime(raw: string): number {
  const t = raw.trim().toUpperCase();
  if (t === 'BOARDING') return 0;
  if (t === 'ARRIVING') return 1;
  const parsed = parseInt(t, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export class MartaAdapter implements TransitProvider {
  readonly agencyId = 'marta';
  readonly agencyName = 'MARTA';
  readonly baseUrl = 'https://developer.itsmarta.com';
  readonly requiresKey = false;

  async getArrivals(stopId: string): Promise<StopArrival[]> {
    const res = await fetch(RAIL_URL);
    if (!res.ok) throw new Error(`MARTA rail feed returned ${res.status}`);
    const rows = (await res.json()) as any[];

    return rows
      .filter((r) => STATION_TO_STOP_ID[String(r.STATION).toUpperCase()] === stopId)
      .map((r) => ({
        stop_id: stopId,
        route_id: r.LINE,
        route_name: `${r.LINE} Line`,
        headsign: r.DESTINATION,
        arrival_min: normalizeWaitingTime(r.WAITING_TIME),
        vehicle_id: r.TRAIN_ID ?? null,
        status: 'realtime' as const,
        source: 'api' as const,
      }));
  }

  async getVehicles(_routeId: string): Promise<VehiclePosition[]> {
    const res = await fetch(BUS_URL);
    if (!res.ok) throw new Error(`MARTA bus feed returned ${res.status}`);
    const rows = (await res.json()) as any[];

    return rows.map((r) => ({
      vehicle_id: r.VEHICLE,
      route_id: r.ROUTE,
      lat: parseFloat(r.LATITUDE),
      lon: parseFloat(r.LONGITUDE),
      bearing: r.HEADING != null ? parseFloat(r.HEADING) : null,
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(RAIL_URL, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }
}
