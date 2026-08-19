import { useEffect, useState } from "react";
import { useAuth } from "./context/AuthContext";
import { ConfigProvider } from "./context/ConfigContext";
import { AppShell } from "./layouts/AppShell";
import type { Tab } from "./layouts/AppShell";
import { flushQueue } from "./lib/syncClient";
import Login from "./screens/Login";
import Dashboard from "./screens/Dashboard";
import WorkOrders from "./screens/WorkOrders";
import Assets from "./screens/Assets";
import MaintenancePlans from "./screens/MaintenancePlans";
import PropertiesScreen from "./screens/Properties";
import Inventory from "./screens/Inventory";
import PurchaseOrders from "./screens/PurchaseOrders";
import Invoices from "./screens/Invoices";
import Contracts from "./screens/Contracts";
import SupplierPortal from "./screens/SupplierPortal";
import TenantPortal from "./screens/TenantPortal";
import Compliance from "./screens/Compliance";
import Team from "./screens/Team";
import Field from "./screens/Field";
import Settings from "./screens/Settings";
import Reports from "./screens/Reports";
import Budgets from "./screens/Budgets";
import OfflineIndicator from "./components/OfflineIndicator";
import UpdatePrompt from "./components/UpdatePrompt";
import InstallPrompt from "./components/InstallPrompt";

export default function App() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("dashboard");

  // Phase 13 (Item 3): when the service worker's background sync fires
  // "flush-queue" (connectivity came back while the tab was backgrounded or
  // closed), flush the offline queue from whatever screen is open.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "flush-queue") void flushQueue();
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  if (!user) return <Login />;

  // Suppliers get a scoped contractor portal instead of the full staff app.
  if (user.role === "supplier")
    return (
      <>
        <OfflineIndicator />
        <UpdatePrompt />
        <InstallPrompt />
        <SupplierPortal />
      </>
    );

  // Phase 4: tenants get a resident portal — file requests + track status.
  if (user.role === "tenant") {
    return (
      <ConfigProvider>
        <OfflineIndicator />
        <UpdatePrompt />
        <InstallPrompt />
        <TenantPortal />
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider>
      <OfflineIndicator />
      <UpdatePrompt />
      <InstallPrompt />
      <AppShell tab={tab} onTab={setTab}>
        {tab === "dashboard" ? <Dashboard /> : null}
        {tab === "workorders" ? <WorkOrders /> : null}
        {tab === "assets" ? <Assets /> : null}
        {tab === "plans" ? <MaintenancePlans /> : null}
        {tab === "properties" ? <PropertiesScreen /> : null}
        {tab === "inventory" ? <Inventory /> : null}
        {tab === "purchase-orders" ? <PurchaseOrders /> : null}
        {tab === "invoices" ? <Invoices /> : null}
        {tab === "contracts" ? <Contracts /> : null}
        {tab === "compliance" ? <Compliance /> : null}
        {tab === "budgets" ? <Budgets /> : null}
        {tab === "reports" ? <Reports /> : null}
        {tab === "team" ? <Team /> : null}
        {tab === "field" ? <Field /> : null}
        {tab === "settings" ? <Settings /> : null}
      </AppShell>
    </ConfigProvider>
  );
}
