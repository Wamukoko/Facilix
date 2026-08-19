// Pluggable object-storage layer for document attachments. Files live behind
// a tiny driver interface (put / get / del / exists) so a deployment can swap
// between local disk (STORAGE_DRIVER=fs — the zero-config dev default) and
// S3-compatible object storage such as MinIO (STORAGE_DRIVER=s3). The driver
// auto-selects s3 when S3_* (or the docker-compose MINIO_*) settings are
// present; set STORAGE_DRIVER=fs to force local disk.
//
// Storage keys are always "<orgId>.<uuid><ext>". The org prefix is the
// multi-tenancy boundary at the key level: the file-stream route refuses keys
// whose prefix does not match the caller's organization, so cross-tenant reads
// are impossible even without a database lookup.

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";

// docker-compose.yml passes MINIO_ENDPOINT/ACCESS/SECRET/BUCKET; the plain
// S3_* names work for AWS/R2 and for local MinIO too.
const hasS3Config = !!(process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT);
const DRIVER = process.env.STORAGE_DRIVER || (hasS3Config ? "s3" : "fs");

const EXT_MIME = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
};

export function contentTypeFor(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

// Build a storage key from the owning org and the original file name. The
// random uuid makes keys unguessable; only the extension carries over. Keys
// are "<orgId>.<uuid><ext>" — a single path segment (the dot separator keeps
// the /files/:key stream route happy without URL-encoding tricks) whose prefix
// is the owning org, enforced by the stream route.
export function newKey(orgId, originalName) {
  const ext = path.extname(String(originalName || ""))
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
  return `${orgId}.${randomUUID()}${ext || ".bin"}`;
}

function assertSafeKey(key) {
  if (typeof key !== "string" || !key || key.includes("\\")) throw new Error("invalid storage key");
  const parts = key.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error("invalid storage key");
  if (parts.length > 3) throw new Error("invalid storage key");
}

// ---------------------------------------------------------------------------
// Local-disk driver (default — no external services required)
// ---------------------------------------------------------------------------
const FS_ROOT = process.env.STORAGE_FS_ROOT || path.resolve(process.cwd(), "uploads");

const fsDriver = {
  async put(key, { buffer }) {
    assertSafeKey(key);
    const full = path.join(FS_ROOT, key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer);
    return { size: buffer.length };
  },
  async get(key) {
    assertSafeKey(key);
    const full = path.join(FS_ROOT, key);
    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      return null;
    }
    return { stream: Readable.from(await fsp.readFile(full)), size: st.size };
  },
  async del(key) {
    assertSafeKey(key);
    await fsp.rm(path.join(FS_ROOT, key), { force: true });
  },
  async exists(key) {
    assertSafeKey(key);
    try {
      await fsp.access(path.join(FS_ROOT, key));
      return true;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// S3-compatible driver (MinIO / AWS S3 / R2 — forcePathStyle for MinIO/R2)
// ---------------------------------------------------------------------------
const S3 = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || (process.env.MINIO_ENDPOINT ? `http://${process.env.MINIO_ENDPOINT}` : "http://127.0.0.1:9000"),
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretAccessKey: process.env.S3_SECRET_KEY || process.env.MINIO_SECRET_KEY || "minioadmin",
  },
});
const BUCKET = process.env.S3_BUCKET || process.env.MINIO_BUCKET || "facilix";

let bucketReady;
function ensureBucket() {
  if (!bucketReady) {
    bucketReady = S3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((err) => {
      // "BucketAlreadyOwnedByYou" / "BucketAlreadyExists" mean it's there — fine.
      if (["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(err?.name)) return true;
      throw err;
    });
  }
  return bucketReady;
}

const s3Driver = {
  async put(key, { buffer, contentType }) {
    assertSafeKey(key);
    await ensureBucket();
    await S3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType })
    );
    return { size: buffer.length };
  },
  async get(key) {
    assertSafeKey(key);
    let out;
    try {
      out = await S3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
    return {
      stream: out.Body,
      size: Number(out.ContentLength || 0),
      contentType: out.ContentType || null,
    };
  },
  async del(key) {
    assertSafeKey(key);
    await S3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  },
  async exists(key) {
    assertSafeKey(key);
    try {
      await S3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  },
};

export const storage = DRIVER === "s3" ? s3Driver : fsDriver;
export const storageDriver = DRIVER;
