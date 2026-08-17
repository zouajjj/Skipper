# Transit Adapter

The `TransitProvider` interface is the only abstraction between Skipper's routing engine and any
transit agency's real-time API. All five current adapters implement this interface. Adding a new
city means writing one file. Nothing else changes.

---

## The Rule

**The routing engine never calls a transit API directly.**

Real-time arrival data is an optional enrichment layer. The route plan is always built from
PostGIS (seeded stops + Haversine). If the transit API is down, fails auth, or returns empty,
Skipper falls back to cached `stop_times` schedule data automatically.

```
Route plan (PostGIS) ──────────────────────────────────► always works
                                │
                     enrichWithArrivals()
                                │
              ┌─────────────────┴─────────────────┐
              │ provider.ping() === true           │ provider.ping() === false
              ▼                                   ▼
  provider.getArrivals(stop_id)         SELECT FROM stop_times
  source: 'api'                         source: 'cached'
```

---

## Interface (`src/transit/TransitProvider.ts`)

**This interface is frozen. Do not change signatures.**

```typescript
export interface StopArrival {
  stop_id:     string;       // matches marta_stops.stop_id
  route_id:    string;       // e.g. "3", "RED", "Piccadilly"
  route_name:  string;       // human readable
  headsign:    string;       // destination on vehicle sign
  arrival_min: number;       // minutes until arrival (0 = now / boarding)
  vehicle_id:  string | null;
  status:      'scheduled' | 'realtime' | 'delayed' | 'cancelled';
  source:      'api' | 'cached';
}

export interface VehiclePosition {
  vehicle_id: string;
  route_id:   string;
  lat:        number;
  lon:        number;
  bearing:    number | null;
  timestamp:  number;        // Unix seconds
}

export interface TransitProvider {
  readonly agencyId:    string;
  readonly agencyName:  string;
  readonly baseUrl:     string;
  readonly requiresKey: boolean;

  getArrivals(stopId: string): Promise<StopArrival[]>;
  getVehicles?(routeId: string): Promise<VehiclePosition[]>;
  ping(): Promise<boolean>;
}
```

---

## Registered Providers (`src/transit/ProviderRegistry.ts`)

```typescript
import { MartaAdapter } from './adapters/MartaAdapter';
import { WmataAdapter } from './adapters/WmataAdapter';
import { CtaAdapter   } from './adapters/CtaAdapter';
import { MtaAdapter   } from './adapters/MtaAdapter';
import { TflAdapter   } from './adapters/TflAdapter';

const REGISTRY: Record<string, TransitProvider> = {
  marta: new MartaAdapter(),
  wmata: new WmataAdapter(process.env.WMATA_API_KEY!),
  cta:   new CtaAdapter(process.env.CTA_API_KEY!),
  mta:   new MtaAdapter(process.env.MTA_API_KEY!),
  tfl:   new TflAdapter(process.env.TFL_APP_ID, process.env.TFL_APP_KEY),
};

export function getProvider(agencyId: string): TransitProvider {
  const p = REGISTRY[agencyId];
  if (!p) throw new Error(`No adapter registered for agency: ${agencyId}`);
  return p;
}
```

---

## Adapter Reference

### MARTA — Atlanta (keyless)

```
Rail arrivals: GET https://developer.itsmarta.com/RealtimeTrain/RestServiceNextTrain/GetRealtimeArrivals
Bus arrivals:  GET https://developer.itsmarta.com/BRDRestService/RestBusRealTimeService/GetAllBus

Rail response fields: DESTINATION, LINE, STATION, TRAIN_ID, WAITING_TIME, EVENT_TIME
Bus response fields:  ROUTE, DIRECTION, STOPID, VEHICLE, LATITUDE, LONGITUDE, HEADING, ADHERENCE

WAITING_TIME normalization:
  'Boarding' → 0 min
  'Arriving' → 1 min
  '5 min'    → parseInt('5') = 5 min

STATION name → stop_id mapping required (MARTA uses full names, we use codes):
  'KING MEMORIAL' → 'KING'
  'FIVE POINTS'   → 'FIVE_PTS'
  'GEORGIA STATE' → 'GEORGIA_ST'
  (full map in src/transit/adapters/MartaAdapter.ts)
```

### WMATA — Washington DC (key required)

```
Register: https://developer.wmata.com
Arrivals:  GET https://api.wmata.com/StationPrediction.svc/json/GetPrediction/{StationCode}
Header:    api_key: {WMATA_API_KEY}

Response field: Trains[].{ Line, DestinationName, Min }
Min normalization: 'ARR' → 0, 'BRD' → 0, '5' → 5
No vehicle positions endpoint.
```

### CTA — Chicago (key required)

```
Register: https://www.transitchicago.com/developers/ttdocs/
Arrivals:  GET https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx?key={KEY}&mapid={STOP}&outputType=JSON
Vehicles:  GET https://lapi.transitchicago.com/api/1.0/ttpositions.aspx?key={KEY}&rt={ROUTE}&outputType=JSON

Arrival time: ctatt.eta[].arrT (ISO8601 string)
Min calc: Math.round((new Date(arrT) - Date.now()) / 60000)
```

### MTA — New York City (key required)

```
Register: https://bustime.mta.info
Protocol: SIRI (not REST — nested XML/JSON structure)
Arrivals:  GET https://bustime.mta.info/api/siri/stop-monitoring.json?key={KEY}&MonitoringRef={STOP}&MaximumStopVisits=5

Nested path: Siri.ServiceDelivery.StopMonitoringDelivery[0].MonitoredStopVisit[].MonitoredVehicleJourney
Arrival time: MonitoredCall.ExpectedArrivalTime (ISO8601)
```

### TfL — London (keyless, higher quota with key)

```
Register (optional): https://api.tfl.gov.uk
Arrivals:  GET https://api.tfl.gov.uk/StopPoint/{NAPTAN_ID}/Arrivals
No auth header needed for low-rate usage.
With key:  append ?app_id={ID}&app_key={KEY}

Response: flat array of arrival objects
Fields: lineName, towards, destinationName, timeToStation (seconds)
Min calc: Math.round(timeToStation / 60)
Stop IDs: NaPTAN format e.g. '940GZZLUKSX' (King's Cross)
```

### Generic GTFS-RT (any agency)

```
Protocol: Protocol Buffers binary feed
Library:  npm install gtfs-realtime-bindings

Feed URL: agency-specific, typically:
  {baseUrl}/trip-updates    → StopTimeUpdate with arrival predictions
  {baseUrl}/vehicle-positions → VehiclePosition with lat/lon

Usage:
  new GtfsRtAdapter('myagency', 'My Agency', 'https://api.myagency.com/gtfs-rt', apiKey)
```

---

## Adding a New City

1. Create `src/transit/adapters/{AgencyName}Adapter.ts`
2. Implement `TransitProvider` — fill `getArrivals()`, `ping()`, optionally `getVehicles()`
3. Add one line to `ProviderRegistry.ts`: `newagency: new AgencyNameAdapter(process.env.AGENCY_KEY!)`
4. Add `AGENCY_KEY=` to `.env.example`
5. Seed the city's stops: update `CITY_BBOXES` in `scripts/seed_pois.py`, add GTFS URL to `seed_bus.py`

That's it. Zero changes to routing, PostGIS queries, or the frontend.

---

## Arrival Cache (`src/transit/ArrivalCache.ts`)

Real-time arrival data is cached in memory for 30 seconds per stop. This prevents hammering
the agency API when multiple users are at the same stop simultaneously.

```typescript
const cache = new Map<string, { data: StopArrival[]; ts: number }>();
const TTL_MS = 30_000;

export async function getCachedArrivals(stopId, fetcher) {
  const hit = cache.get(stopId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  const data = await fetcher();
  cache.set(stopId, { data, ts: Date.now() });
  return data;
}
```

For production with multiple backend instances, replace `Map` with Redis and set TTL there.

---

## API Endpoint (`GET /api/arrivals`)

```
GET /api/arrivals?stop_id=KING&agency=marta

Response:
{
  "stop_id": "KING",
  "agency": "marta",
  "source": "api" | "cached",
  "arrivals": [StopArrival, ...]
}
```

The frontend never calls transit APIs directly. This endpoint is the only proxy.
