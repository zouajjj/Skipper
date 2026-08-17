# Frontend

Skipper's frontend is a single HTML file (`public/skipper.html`) — no build step, no framework,
no bundler. It works fully offline using client-side Haversine and Overpass/OSM for eatery data.
The backend API layer enriches it with PostGIS queries and real-time arrivals.

---

## File Structure

```
public/
└── skipper.html         ← entire PWA — HTML, CSS, JS in one file
                           works standalone (open in browser, no server)
                           also served by Express at GET /
```

---

## Key Constants

```js
// Mock coordinates — always use these for dev/testing
const MOCK_LAT = 33.74976256840587;
const MOCK_LON = -84.37726057107493;
// This is near King Memorial Station (BLUE/GREEN), 0.28 mi away

// MARTA rail stations (seeded in-browser until PostGIS backend is live)
const RAIL = [
  {id:"KING",     name:"King Memorial",  lat:33.7488, lon:-84.3765, lines:["BLUE","GREEN"]},
  {id:"FIVE_PTS", name:"Five Points",    lat:33.7538, lon:-84.3908, lines:["RED","GOLD","BLUE","GREEN"]},
  // ... 34 total — see public/skipper.html for full array
];
```

---

## Distance Calculation

Haversine formula — mirrors `ST_Distance(GEOGRAPHY)` without a server call.

```js
// src/utils/haversine.js
function hav(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // miles
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dO = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dL/2)**2
          + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```

**When to use Haversine vs PostGIS:**
- Client-side nearest stop (offline, <34 rail stations): Haversine
- Server-side nearest stop (full 7k bus stops): PostGIS KNN `<->`
- Walking distance estimate in route legs: Haversine (accuracy ~0.3%, acceptable)
- Never use Haversine for database queries — always PostGIS there

---

## Canvas MARTA Map

The canvas renders the full rail network as colored polylines, user position as a glowing dot,
selected POI as a pink dot, and the route as dashed walk segments + solid transit segment.

```js
// Key rendering order (painter's algorithm)
// 1. Grid background
// 2. Rail lines (GREEN, BLUE, GOLD, RED — draw less dominant colors first)
// 3. Station dots (white, larger for nearby, labeled if within 1 mile)
// 4. Route overlay: dashed walk → solid transit → dashed walk to POI
// 5. POI dot + label (pink)
// 6. User dot + glow (blue, drawn last = always on top)

// Coordinate transform: WGS84 lat/lon → canvas pixels
function toXY(lat, lon, bounds, canvasW, canvasH) {
  const pad = 38;
  return {
    x: pad + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (canvasW - pad*2),
    y: pad + (1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * (canvasH - pad*2)
  };
}

// Bounds include 0.025° padding around the full station extent
// Always call ctx.setTransform(dpr, 0, 0, dpr, 0, 0) after resize (devicePixelRatio support)
```

**Canvas line colors:**
```js
const LINE_CLR = { RED:"#ef4444", GOLD:"#f59e0b", BLUE:"#3b82f6", GREEN:"#22c55e" };
```

---

## Location Flow

```
1. User taps "Use my real location"
     ↓
2. navigator.geolocation.getCurrentPosition()
     ↓ success               ↓ error
3a. onLocOk(lat, lon)    3b. Show error message
     ↓                        ↓
4.  Draw user dot on canvas   Show "Use demo coordinates" button
     ↓
5.  fetchEateries(lat, lon)   ← Overpass API call
     ↓
6.  renderEateries(elements)  ← filter unnamed, sort by distance
     ↓
7.  User taps eatery card → selectPOI(poi)
     ↓
8.  buildRoute(origin, poi)   ← Haversine legs, nearest stop each end
     ↓
9.  Show route panel + "Open in Maps" / "Transit ↗" buttons

// Demo coordinates button bypasses geolocation entirely:
function useMock() { onLocOk(MOCK_LAT, MOCK_LON, true); }
```

---

## Overpass POI Fetch

```js
// Fired after location acquired — replaces per-user Overpass call with seeded pois table
// once the backend is live (swap fetchEateries for GET /api/pois?lat=&lon=&radius=)
async function fetchEateries(lat, lon) {
  const query = `[out:json][timeout:28];
    (node["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|bakery|deli)$"](around:1400,${lat},${lon});
     way["amenity"~"..."](around:1400,${lat},${lon}););
    out center 80;`;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', body: 'data=' + encodeURIComponent(query)
  });
  const { elements } = await res.json();
  // Filter: must have lat/lon and a name tag
  // Sort: by Haversine distance from user
  // Slice: first 30
}
```

**Migration path to seeded POIs:**
Once `sync_pois.py` is running nightly, replace the Overpass fetch with:
```js
const res = await fetch(`/api/pois?lat=${lat}&lon=${lon}&radius=1400&amenity=restaurant,cafe,bar,fast_food`);
const { pois } = await res.json();
```

---

## "Open in Maps" Deep-Link

Final walking leg always uses a system deep-link — no Maps SDK needed.

```js
function buildMapsUri(lat, lon, label) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    return `maps://maps.apple.com/?daddr=${lat},${lon}&dirflg=w`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking&destination_place_name=${encodeURIComponent(label)}`;
}

// Transit full-route deep-link (opens Google Maps with transit routing)
function buildTransitUri(originLat, originLon, destLat, destLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLon}&destination=${destLat},${destLon}&travelmode=transit`;
}
```

---

## Route Leg Assembly

```js
function buildRoute(userLat, userLon, poi) {
  const origin = nearestStop(userLat, userLon);   // Haversine over RAIL[]
  const dest   = nearestStop(poi.lat, poi.lon);   // same

  const w1 = hav(userLat, userLon, origin.lat, origin.lon);   // walk to board stop
  const w2 = hav(poi.lat, poi.lon, dest.lat, dest.lon);       // walk from alight stop
  const td = hav(origin.lat, origin.lon, dest.lat, dest.lon); // transit distance

  return {
    total_min: Math.round(w1*20) + Math.max(2, Math.round(td*3.8)) + Math.round(w2*20),
    legs: [
      { type:'walk',    from:'Your Location',  to:origin.name, dist_mi:w1,  min:Math.round(w1*20) },
      { type:'transit', from:origin.name,      to:dest.name,   dist_mi:td,  min:Math.max(2,Math.round(td*3.8)), lines:origin.lines },
      { type:'walk',    from:dest.name,         to:poi.name,    dist_mi:w2,  min:Math.round(w2*20) },
    ],
    disclaimer: 'Times estimated from cached schedule — verify at itsmarta.com',
  };
}

// Walk speed assumption: 20 min/mile (3 mph)
// Transit speed assumption: ~15 mph average including stops (3.8 min/mile)
// Both are conservative estimates appropriate for a "plan before you go" use case
```

---

## UI Components Built

All implemented in `public/skipper.html` and the chat artifacts:

| Component | Description |
|---|---|
| Location bar | GPS / mock toggle, coordinate display, nearest stop pill |
| Eatery grid | Overpass results, filter chips (All/Restaurant/Cafe/Bar/Quick bite) |
| Bus stop list | Seeded stops from PostGIS, sorted by ST_DWithin KNN |
| McDonald's POI list | `amenity=fast_food, name ILIKE '%mcdonald%'` from seeded pois |
| Route panel | Three-leg step display, total time, "Open in Maps" + "Transit ↗" |
| Canvas MARTA map | Full rail network, user dot, POI dot, route overlay |
| Seed dashboard | Three-phase seed simulation, live table stats, PostGIS query explorer |
| Transit adapter switcher | Provider registry, live ping status, arrival simulation |

---

## Design System

Fonts: `Syne` (display/headings), `DM Sans` (body), `DM Mono` (data/code)
Colors: Dark theme `#0d0f14` bg, `#63b3ff` accent, `#f5a623` amber (transit), `#f472b6` POI
Rail line colors: RED `#ef4444`, GOLD `#f59e0b`, BLUE `#3b82f6`, GREEN `#22c55e`
McDonald's brand: `#DA291C` background, `#FFC72C` M letterform
