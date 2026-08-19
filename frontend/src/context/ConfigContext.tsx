import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Config, ConfigType } from "../lib/types";
import { api } from "../lib/api";

interface ConfigState {
  config: Config | null;
  reload(): Promise<void>;
  tradeLabel(value: string | null | undefined): string;
  assetTypeLabel(value: string | null | undefined): string;
  addTrade(value: string, label: string): Promise<void>;
  addAssetType(value: string, label: string): Promise<void>;
  toggleTrade(value: string, active: boolean): Promise<void>;
  toggleAssetType(value: string, active: boolean): Promise<void>;
  setAutoAssign(enabled: boolean): Promise<void>;
}

const ConfigContext = createContext<ConfigState | null>(null);

function titleCase(v: string): string {
  return v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);

  const reload = useCallback(async () => {
    try {
      const c = await api.get<Config>("/config");
      setConfig(c);
    } catch {
      // A failed config fetch should not crash the app — screens fall back to
      // the built-in vocabulary in format.ts.
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const findLabel = useCallback((list: ConfigType[] | undefined, value: string | null | undefined) => {
    if (!value) return "";
    const entry = list?.find((t) => t.value === value && t.active);
    return entry ? entry.label : titleCase(value);
  }, []);

  const tradeLabel = useCallback((v: string | null | undefined) => findLabel(config?.trades, v), [config, findLabel]);
  const assetTypeLabel = useCallback(
    (v: string | null | undefined) => findLabel(config?.asset_types, v),
    [config, findLabel]
  );

  const addTrade = useCallback(async (value: string, label: string) => {
    await api.post<ConfigType>("/config/trades", { value, label });
    await reload();
  }, [reload]);

  const addAssetType = useCallback(async (value: string, label: string) => {
    await api.post<ConfigType>("/config/asset_types", { value, label });
    await reload();
  }, [reload]);

  const toggleTrade = useCallback(async (value: string, active: boolean) => {
    await api.patch<ConfigType>(`/config/trades/${value}`, { active });
    await reload();
  }, [reload]);

  const toggleAssetType = useCallback(async (value: string, active: boolean) => {
    await api.patch<ConfigType>(`/config/asset_types/${value}`, { active });
    await reload();
  }, [reload]);

  const setAutoAssign = useCallback(async (enabled: boolean) => {
    await api.patch<{ auto_assign_suppliers: boolean }>("/config/auto-assign", { auto_assign_suppliers: enabled });
    await reload();
  }, [reload]);

  const value = useMemo(
    () => ({ config, reload, tradeLabel, assetTypeLabel, addTrade, addAssetType, toggleTrade, toggleAssetType, setAutoAssign }),
    [config, reload, tradeLabel, assetTypeLabel, addTrade, addAssetType, toggleTrade, toggleAssetType, setAutoAssign]
  );

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigState {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used within a ConfigProvider");
  return ctx;
}
