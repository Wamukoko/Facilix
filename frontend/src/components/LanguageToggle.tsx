import { useI18n } from "../context/I18nContext";

export default function LanguageToggle() {
  const { lang, setLang, t } = useI18n();

  function toggle() {
    setLang(lang === "en" ? "sw" : "en");
  }

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs font-semibold text-dim transition-colors hover:text-ink"
      title={t("lang.switch")}
    >
      {lang === "en" ? "🇰🇪 SW" : "🇬🇧 EN"}
    </button>
  );
}
