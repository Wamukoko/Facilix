// Geocoding via OpenStreetMap's Nominatim. The `fetcher` argument is
// injectable so unit tests can stub the network without hitting Nominatim.
// Results are cached in memory per normalized query (the demo runs short,
// repeated lookups; a production build would move to a real geocoder).

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "FacilixDemo/1.0 (facility maintenance demo)";

const cache = new Map();

export function clearGeocodeCache() {
  cache.clear();
}

export async function geocodeQuery(query, fetcher = fetch) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const url = `${NOMINATIM_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetcher(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`geocoder returned ${res.status}`);
  const json = await res.json();
  const rows = (Array.isArray(json) ? json : [])
    .map((r) => ({
      display_name: typeof r.display_name === "string" ? r.display_name : null,
      lat: Number(r.lat),
      lng: Number(r.lon),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));

  cache.set(key, rows);
  return rows;
}
