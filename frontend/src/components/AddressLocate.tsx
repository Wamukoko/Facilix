import { useState } from "react";
import { api } from "../lib/api";

export interface GeocodeResult {
  display_name: string | null;
  lat: number;
  lng: number;
}

// "Locate address" — asks the API to geocode the typed address (Nominatim/OSM)
// and shows a short picker so the user can confirm the right match instead of
// typing raw coordinates. Degrades gracefully: the coordinate fields stay
// editable and the caller can fall back to manual entry.
export function AddressLocate({
  address,
  onPick,
}: {
  address: string;
  onPick: (result: GeocodeResult) => void;
}) {
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locate = async () => {
    setError(null);
    if (!address.trim()) {
      setError("Type an address first.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.get<GeocodeResult[]>("/properties/geocode", { q: address.trim() });
      setResults(res);
      if (res.length === 0) setError("No matches found — enter coordinates manually.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Geocoding failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={locate}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-dim transition-colors hover:text-ink disabled:opacity-50"
      >
        {loading ? "Locating…" : "Locate address"}
      </button>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      {results.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {results.map((r, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setResults([]);
                }}
                className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:border-amber"
              >
                {r.display_name ?? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
