import { StopArrival } from './TransitProvider';

const cache = new Map<string, { data: StopArrival[]; ts: number }>();
const TTL_MS = 30_000;

export async function getCachedArrivals(
  stopId: string,
  fetcher: () => Promise<StopArrival[]>
): Promise<StopArrival[]> {
  const hit = cache.get(stopId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const data = await fetcher();
  cache.set(stopId, { data, ts: Date.now() });
  return data;
}
