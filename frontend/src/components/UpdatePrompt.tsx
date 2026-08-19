import { useEffect, useState } from "react";

// Non-intrusive toast that appears when a new service worker version is
// available.  Offers a single "Update" button that tells the SW to skip
// waiting (activating the new version) and reloads the page so the fresh
// assets are served.

export default function UpdatePrompt() {
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration) return;
      setReg(registration);
      if (registration.waiting) setShow(true);

      registration.addEventListener("updatefound", () => {
        const sw = registration.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            setShow(true);
          }
        });
      });
    });
  }, []);

  if (!show || !reg) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-xs font-semibold text-ink shadow-lg">
      <span>New version available</span>
      <button
        onClick={() => reg.waiting?.postMessage({ type: "skip-waiting" })}
        className="rounded-lg bg-amber px-3 py-1.5 text-xs font-bold text-bg transition-colors hover:brightness-110"
      >
        Update
      </button>
    </div>
  );
}
