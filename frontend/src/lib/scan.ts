// QR/NFC tag reading for the resident portal (Phase 4). Wraps the browser's
// Web NFC (Android Chrome), BarcodeDetector camera scanning (Chromium), and a
// jsQR image-decoding fallback so a site tag can be read on any device.
//
// A tag payload is either a plain location hint ("Unit 7B — Ensuite") or a
// Facilix URL that also pre-fills the trade:
//   facilix://trade/<trade>       e.g. facilix://trade/plumbing
//   facilix://location/<text>     e.g. facilix://location/Unit 7B ensuite
//   plain text                    treated as a location hint

import jsQR from "jsqr";

export interface TagPayload {
  trade?: string;
  location?: string;
  raw: string;
}

export function parseTagPayload(text: string, availableTrades: string[]): TagPayload {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower.startsWith("facilix://")) {
    const body = t.slice("facilix://".length);
    const [kind, ...rest] = body.split("/");
    if (kind === "trade" && rest.length && availableTrades.includes(rest[0])) {
      return { trade: rest[0], raw: t };
    }
    if (kind === "location") {
      return { location: rest.join("/") || t, raw: t };
    }
    return { location: t, raw: t };
  }
  return { location: t, raw: t };
}

// --- Browser capability detection (typed as unknown APIs) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtor = any;

export function hasNfc(): boolean {
  return typeof (window as unknown as { NDEFReader?: AnyCtor }).NDEFReader !== "undefined";
}

export function hasBarcodeDetector(): boolean {
  return typeof (window as unknown as { BarcodeDetector?: AnyCtor }).BarcodeDetector !== "undefined";
}

// Start listening for an NFC tag; resolves with a stop() function.
export async function startNfcScan(onPayload: (text: string) => void): Promise<() => void> {
  const NDEFReader = (window as unknown as { NDEFReader: AnyCtor }).NDEFReader;
  const reader = new NDEFReader();
  await reader.scan();
  const handler = (event: AnyCtor) => {
    const record = event?.message?.records?.[0];
    if (record?.data) onPayload(new TextDecoder().decode(record.data));
  };
  reader.addEventListener("reading", handler);
  return () => {
    reader.removeEventListener("reading", handler);
    try {
      reader.stop?.();
    } catch {
      // already stopped
    }
  };
}

// Scan the camera feed for a QR code using BarcodeDetector. `video` is a
// <video> element rendered by the caller; resolves with a stop() function.
export async function scanWithCamera(
  video: HTMLVideoElement,
  onPayload: (text: string) => void
): Promise<() => void> {
  const BarcodeDetector = (window as unknown as { BarcodeDetector: AnyCtor }).BarcodeDetector;
  const detector = new BarcodeDetector({ formats: ["qr_code"] });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  video.autoplay = true;
  await video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  let raf = 0;

  async function tick() {
    if (stopped || !ctx || video.readyState < 2) {
      raf = requestAnimationFrame(tick);
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    try {
      const codes = await detector.detect(canvas);
      if (codes.length > 0 && codes[0].rawValue) {
        onPayload(codes[0].rawValue);
        cleanup();
        return;
      }
    } catch {
      // detection error on this frame — keep trying
    }
    raf = requestAnimationFrame(tick);
  }

  function cleanup() {
    stopped = true;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((tr) => tr.stop());
    video.srcObject = null;
  }

  raf = requestAnimationFrame(tick);
  return cleanup;
}

// Decode a QR code from an uploaded photo via jsQR.
export async function decodeQrImage(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 640;
    canvas.height = img.naturalHeight || 480;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(data.data, data.width, data.height)?.data ?? null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
