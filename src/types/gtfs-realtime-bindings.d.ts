// Ambient shim so the scaffold type-checks without this optional package installed.
// Run `npm install gtfs-realtime-bindings` for full types when using GtfsRtAdapter.
declare module 'gtfs-realtime-bindings' {
  const transit_realtime: any;
  export { transit_realtime };
}
