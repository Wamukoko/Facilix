import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { I18nProvider } from "./context/I18nContext";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </AuthProvider>
  </StrictMode>
);

// Phase 16 — PWA shell. Registered only in production builds: a service worker
// in dev (with HMR) would serve stale modules and mask the live-edit cycle.
//
// When a new SW activates and claims clients, the browser fires
// "controllerchange". We reload immediately so the fresh shell (new JS/CSS
// hashes) is served instead of the stale cached page. This listener lives in
// main.tsx (not a component) so it runs on every page load — including the
// login screen where UpdatePrompt isn't rendered yet.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
