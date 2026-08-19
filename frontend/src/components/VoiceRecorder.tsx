import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { Button } from "./ui";

// Phase 4 — an inline voice-note recorder for the resident portal. Uses
// MediaRecorder to capture audio/webm with a duration readout and an inline
// player to preview before filing. Degrades to a clear error message when
// recording isn't supported (the parent still offers an audio-file fallback).

interface Props {
  onRecorded: (file: File, durationMs: number) => void;
}

export default function VoiceRecorder({ onRecorded }: Props) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop());
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      mediaRef.current = rec;
      chunksRef.current = [];
      startRef.current = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const ms = Date.now() - startRef.current;
        stream.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        setPreviewUrl(URL.createObjectURL(blob));
        setDuration(0);
        setRecording(false);
        onRecorded(new File([blob], "voice-note.webm", { type: blob.type || "audio/webm" }), ms);
      };
      rec.start();
      setRecording(true);
      setDuration(0);
      timerRef.current = window.setInterval(() => setDuration((d) => d + 1), 1000);
    } catch {
      setError("Voice recording isn't available in this browser — attach an audio file instead.");
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    mediaRef.current?.stop();
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }

  return (
    <div className="space-y-2">
      {recording ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
          <span className="text-xs font-semibold text-danger">Recording {duration}s</span>
          <Button type="button" variant="secondary" className="ml-auto !px-2 !py-1 text-xs" onClick={stop}>
            <Square size={12} /> Stop
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          className="w-full justify-start"
          disabled={busy}
          onClick={start}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
          {busy ? "Starting microphone…" : "Record a voice note"}
        </Button>
      )}
      {previewUrl ? <audio controls src={previewUrl} className="h-9 w-full" /> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
