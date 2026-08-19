import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Download, File, FileText, Film, Image as ImageIcon, Loader2, Paperclip, Trash2 } from "lucide-react";
import type { Document } from "../lib/types";
import { formatDate, titleCase } from "../lib/format";
import { api, download, getBlob, upload } from "../lib/api";
import { Button, ErrorBanner, Spinner } from "./ui";

interface Props {
  entityType: "work_order" | "asset" | "property" | "contract";
  entityId: string;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/heic"];
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

function FileGlyph({ doc }: { doc: Document }) {
  const type = doc.content_type ?? "";
  if (IMAGE_TYPES.includes(type)) return <ImageIcon size={16} className="text-plumbing" />;
  if (VIDEO_TYPES.includes(type)) return <Film size={16} className="text-amber" />;
  if (type === "application/pdf") return <FileText size={16} className="text-danger" />;
  return <File size={16} className="text-dim" />;
}

export default function DocumentAttachments({ entityType, entityId }: Props) {
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  async function load() {
    setError(null);
    try {
      const res = await api.get<{ data: Document[] }>("/documents", {
        entity_type: entityType,
        entity_id: entityId,
      });
      setDocs(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load attachments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [entityType, entityId]);

  // Revoke object URLs when the preview map changes or the component unmounts.
  useEffect(() => {
    const urls = Object.values(previews);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [previews]);

  // Fetch authenticated blob URLs for image previews (img tags can't send the
  // Authorization header, so we go through getBlob → object URL).
  async function ensurePreview(doc: Document) {
    if (previews[doc.id] || !IMAGE_TYPES.includes(doc.content_type ?? "")) return;
    try {
      const { blob } = await getBlob(doc.file_url);
      setPreviews((p) => ({ ...p, [doc.id]: URL.createObjectURL(blob) }));
    } catch {
      // non-fatal — the row still renders as a plain list item
    }
  }

  useEffect(() => {
    docs.filter((d) => IMAGE_TYPES.includes(d.content_type ?? "")).forEach((d) => ensurePreview(d));
  }, [docs]);

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await upload("/documents", file, { entity_type: entityType, entity_id: entityId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function onDelete(doc: Document) {
    setDeleting(doc.id);
    setError(null);
    try {
      await api.del(`/documents/${doc.id}`);
      setPreviews((p) => {
        const next = { ...p };
        if (next[doc.id]) URL.revokeObjectURL(next[doc.id]);
        delete next[doc.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div className="space-y-3">
      {error ? <ErrorBanner message={error} /> : null}

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-dim">
          {docs.length === 0
            ? "No attachments yet — photos, PDFs and notes live here for the whole crew."
            : `${docs.length} attachment${docs.length === 1 ? "" : "s"}`}
        </p>
        <input ref={fileInput} type="file" className="hidden" onChange={onUpload} />
        <Button variant="secondary" className="!px-2 !py-1 text-xs" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
          {uploading ? "Uploading…" : "Attach file"}
        </Button>
      </div>

      {docs.length > 0 ? (
        <ul className="space-y-2">
          {docs.map((doc) => {
            const preview = previews[doc.id];
            return (
              <li key={doc.id} className="rounded-lg border border-line bg-bg p-2">
                <div className="flex items-center gap-3">
                  {preview ? (
                    <img src={preview} alt={doc.file_name} className="h-12 w-12 rounded object-cover" />
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded bg-panel-2 text-ink">
                      <FileGlyph doc={doc} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink" title={doc.file_name}>
                      {doc.file_name}
                    </p>
                    <p className="text-xs text-dim">
                      {doc.uploaded_by_name ? `${titleCase(doc.uploaded_by_name)} · ` : ""}
                      {formatDate(doc.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title="Download"
                      className="rounded p-1.5 text-dim transition-colors hover:bg-panel-2 hover:text-ink"
                      onClick={() => download(doc.file_url, doc.file_name).catch(() => {})}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      disabled={deleting === doc.id}
                      className="rounded p-1.5 text-dim transition-colors hover:bg-danger/10 hover:text-danger"
                      onClick={() => onDelete(doc)}
                    >
                      {deleting === doc.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
