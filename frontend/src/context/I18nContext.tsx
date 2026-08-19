import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Lang } from "../lib/i18n";
import { translations, getStoredLang } from "../lib/i18n";

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Translate a key — falls back to the key itself if missing. */
  t: (key: string) => string;
}

const Ctx = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getStoredLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem("facilix_lang", l);
  }, []);

  const t = useCallback((key: string): string => {
    const entry = translations[key];
    if (!entry) return key;
    return entry[lang] ?? entry.en ?? key;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}
