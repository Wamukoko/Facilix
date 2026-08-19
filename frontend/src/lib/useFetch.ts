import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

// Fetches a paginated endpoint, with loading/error state and a reload hook
// for refreshing after mutations. `query` must be referentially stable
// between renders (declare it outside the component, or memoize it).
export function useFetch<T>(path: string | null, query?: Record<string, string | number | undefined>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: string | null, q?: Record<string, string | number | undefined>) => {
    if (!p) { setLoading(false); setError(null); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<T>(p, q);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const queryKey = JSON.stringify(query ?? {});

  useEffect(() => {
    if (path) void load(path, query);
    else { setLoading(false); setError(null); }
  }, [path, load, queryKey]);

  return {
    data,
    error,
    loading,
    reload: () => load(path, query),
  };
}
