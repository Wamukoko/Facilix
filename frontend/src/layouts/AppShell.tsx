import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import LanguageToggle from "../components/LanguageToggle";

export type Tab =
  | "dashboard"
  | "workorders" | "assets" | "plans" | "properties"
  | "compliance"
  | "reports"
  | "team"
  | "inventory" | "purchase-orders" | "invoices" | "contracts" | "budgets"
  | "field" | "settings";

// Left-side tabs (always visible)
const LEFT_TABS: { id: Tab; key: string }[] = [
  { id: "workorders", key: "nav.workOrders" },
  { id: "field", key: "nav.tools" },
  { id: "assets", key: "nav.assets" },
  { id: "compliance", key: "nav.compliance" },
  { id: "team", key: "nav.team" },
  { id: "properties", key: "nav.properties" },
  { id: "reports", key: "nav.reports" },
];

// Financials group — parent shows on main row, children on second row
const ALL_FINANCIALS_CHILDREN: { id: Tab; key: string }[] = [
  { id: "inventory", key: "nav.inventory" },
  { id: "purchase-orders", key: "nav.purchaseOrders" },
  { id: "invoices", key: "nav.invoices" },
  { id: "contracts", key: "nav.contracts" },
  { id: "budgets", key: "nav.budgets" },
];

// Managers only see Inventory + Purchase Orders in Financials.
const MANAGER_FINANCIALS_CHILDREN = ALL_FINANCIALS_CHILDREN.filter(
  (c) => c.id === "inventory" || c.id === "purchase-orders"
);

export function AppShell({ tab, onTab, children }: { tab: Tab; onTab: (t: Tab) => void; children: ReactNode }) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  if (!user) return null;

  const isTechnician = user.role === "technician";
  const isManager = user.role === "manager";
  const isAdmin = user.role === "admin";

  const financialsChildren = isManager ? MANAGER_FINANCIALS_CHILDREN : ALL_FINANCIALS_CHILDREN;
  const financialsIds = new Set(financialsChildren.map((c) => c.id));
  const isFinancialsActive = financialsIds.has(tab);

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-50 bg backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-3">

          {/* Top bar — logo + user info */}
          <div className="flex items-center justify-between gap-4">
            <span className="text-lg font-black tracking-tight text-ink">
              Facilix<span className="text-amber">.</span>
            </span>
            <div className="flex items-center gap-3">
              {user.organization_name ? (
                <span className="hidden text-sm text-dim lg:inline">{user.organization_name}</span>
              ) : null}
              <span className="text-sm text-dim">{user.full_name}</span>
              <span className="text-xs font-semibold uppercase text-amber">{user.role}</span>
              <LanguageToggle />
              <button
                onClick={logout}
                className="rounded-lg px-2 py-1 text-sm text-dim hover:text-ink transition-colors"
              >
                {t("action.signOut")}
              </button>
            </div>
          </div>

          {/* Row 1 — main nav tabs, evenly spread */}
          <nav className="mt-2 flex items-center">
            {LEFT_TABS.filter((e) => isTechnician ? e.id !== "reports" : true).map((entry) => (
              <button
                key={entry.id}
                onClick={() => onTab(entry.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                  tab === entry.id && !isFinancialsActive ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
                }`}
              >
                {t(entry.key)}
              </button>
            ))}

            {/* Financials parent — hidden for technicians */}
            {!isTechnician && financialsChildren.length > 0 && (
              <button
                onClick={() => onTab(financialsChildren[0].id)}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                  isFinancialsActive ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
                }`}
              >
                {t("nav.financials")}
                <ChevronDown
                  size={13}
                  className={`transition-transform ${isFinancialsActive ? "rotate-180 text-amber" : ""}`}
                />
              </button>
            )}

            {/* Settings pinned far right — hidden for technicians and managers */}
            {isAdmin && (
              <div className="ml-auto">
                <button
                  onClick={() => onTab("settings")}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                    tab === "settings" ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
                  }`}
                >
                  {t("nav.settings")}
                </button>
              </div>
            )}
          </nav>

          {/* Row 2 — Financials sub-tabs (only when a financials child is active) */}
          {isFinancialsActive && (
            <nav className="flex items-center gap-1">
              {financialsChildren.map((child) => (
                <button
                  key={child.id}
                  onClick={() => onTab(child.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                    tab === child.id ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
                  }`}
                >
                  {t(child.key)}
                </button>
              ))}
            </nav>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
