import { useEffect, useState } from "react";

// Small fixed bar at the bottom of the viewport that appears when the browser
// goes offline and disappears when connectivity returns.  Stays non-intrusive
// so users can still read already-loaded data while disconnected.

export default function OfflineIndicator() {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 bg-panel px-4 py-2 text-xs font-semibold text-amber shadow-[0_-2px_8px_rgba(0,0,0,.4)]"
    >
      <span className="inline-block h-2 w-2 rounded-full bg-amber animate-pulse" />
      You are offline — changes will sync when connectivity returns
    </div>
  );
}
