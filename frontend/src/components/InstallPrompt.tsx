import { useEffect, useState } from "react";

// "Add to Home Screen" banner.  Captures the browser's `beforeinstallprompt`
// event and shows a non-intrusive button.  Once the user taps it (or dismisses
// it), the banner hides for the rest of the session.  Only shown when the app
// isn't already installed (no `display-mode: standalone`).

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<Event | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Already in standalone mode — no need to prompt.
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!show || !deferred) return null;

  const install = async () => {
    (deferred as any).prompt();
    const { outcome } = await (deferred as any).userChoice;
    // Whether accepted or dismissed, don't show again this session.
    setShow(false);
    setDeferred(null);
    if (outcome === "accepted") {
      console.log("[pwa] user installed");
    }
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-xs font-semibold text-ink shadow-lg">
      <span>Install Facilix on your device</span>
      <button
        onClick={install}
        className="rounded-lg bg-amber px-3 py-1.5 text-xs font-bold text-bg transition-colors hover:brightness-110"
      >
        Install
      </button>
      <button
        onClick={() => { setShow(false); setDeferred(null); }}
        className="ml-1 text-dim transition-colors hover:text-ink"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
