import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, KeyRound, Loader2, Nfc, ScanLine, X } from "lucide-react";
import { Button, ErrorBanner, Field, Input, Modal } from "./ui";
import { decodeQrImage, hasBarcodeDetector, hasNfc, scanWithCamera, startNfcScan } from "../lib/scan";

// Phase 4 — scan a site tag (QR code or NFC tag) from the resident portal so
// a one-minute request auto-fills its location. Tries every mechanism the
// device supports: Web NFC (Android Chrome), BarcodeDetector camera scanning
// (Chromium), a photo-upload jsQR decode, and manual code entry.

type Mode = "choose" | "nfc" | "camera" | "manual";

interface Props {
  open: boolean;
  onClose: () => void;
  onTag: (text: string) => void;
}

export default function ScanTagModal({ open, onClose, onTag }: Props) {
  const [mode, setMode] = useState<Mode>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [nfcText, setNfcText] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const nfc = hasNfc();
  const barcode = hasBarcodeDetector();

  // Latest callbacks live in refs so the camera effect never restarts just
  // because the parent re-renders (identity of onTag/onClose changes).
  const cbRef = useRef({ onTag, onClose });
  cbRef.current = { onTag, onClose };

  useEffect(() => {
    if (!open) return;
    setMode("choose");
    setError(null);
    setBusy(false);
    setManual("");
    setNfcText(null);
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "camera" || !barcode || !videoRef.current) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    scanWithCamera(videoRef.current!, (text) => {
      if (cancelled) return;
      cbRef.current.onTag(text);
      cbRef.current.onClose();
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        stopRef.current = stop;
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not start the camera"))
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [open, mode, barcode]);

  async function onStartNfc() {
    setError(null);
    setBusy(true);
    try {
      const stop = await startNfcScan((text) => {
        setNfcText(text);
        onTag(text);
        onClose();
      });
      stopRef.current = stop;
      setMode("nfc");
    } catch (err) {
      setError(err instanceof Error ? err.message : "NFC is not available on this device");
    } finally {
      setBusy(false);
    }
  }

  async function onPickImage(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const text = await decodeQrImage(file);
      if (text) {
        onTag(text);
        onClose();
      } else {
        setError("No QR code found in that photo — try a clearer shot.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image");
    } finally {
      setBusy(false);
    }
  }

  function onApplyManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manual.trim()) return;
    onTag(manual.trim());
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Scan a site tag">
      <p className="-mt-2 mb-4 text-xs text-dim">
        Scan the QR code or NFC tag on the wall outside — it fills in where the fault is (and
        sometimes the category) so you can report it in seconds.
      </p>

      {error ? <div className="mb-3"><ErrorBanner message={error} /></div> : null}

      {mode === "camera" ? (
        <div className="space-y-3">
          <video ref={videoRef} className="aspect-video w-full rounded-lg bg-black object-cover" />
          <p className="text-xs text-dim">Point the camera at the QR code on the tag.</p>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={() => setMode("choose")}>
              <X size={14} /> Cancel scan
            </Button>
          </div>
        </div>
      ) : mode === "nfc" ? (
        <div className="space-y-3">
          <div className="flex items-center justify-center gap-3 rounded-lg border border-dashed border-line bg-bg px-4 py-6 text-sm text-dim">
            <Nfc size={18} className="text-amber" />
            Tap the tag with the back of your phone…
          </div>
          {nfcText ? (
            <p className="text-xs font-semibold text-gardening">Read “{nfcText}”.</p>
          ) : null}
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={() => setMode("choose")}>
              <X size={14} /> Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {nfc ? (
            <Button type="button" variant="secondary" className="w-full justify-start" disabled={busy} onClick={onStartNfc}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Nfc size={14} />}
              Scan NFC tag
            </Button>
          ) : null}
          {barcode ? (
            <Button
              type="button"
              variant="secondary"
              className="w-full justify-start"
              disabled={busy}
              onClick={() => setMode("camera")}
            >
              <Camera size={14} /> Scan with camera
            </Button>
          ) : null}

          <label className="block">
            <span className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm font-semibold text-ink transition-colors hover:bg-panel-2">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
              {busy ? "Reading photo…" : "Upload a photo of the tag"}
            </span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                void onPickImage(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>

          <form onSubmit={onApplyManual} className="space-y-2">
            <Field label="…or type the code on the tag">
              <div className="flex gap-2">
                <Input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="e.g. Unit 7B or facilix://trade/plumbing"
                  disabled={busy}
                />
                <Button type="submit" disabled={busy || !manual.trim()}>
                  <KeyRound size={14} /> Apply
                </Button>
              </div>
            </Field>
          </form>

          <div className="flex justify-end pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              <ScanLine size={14} /> Not now
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
