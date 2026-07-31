import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { extname } from "node:path";
import { env } from "../config/env";
import { AppError, badRequest } from "./errors";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new AppError(503, "Cloudinary is not configured", "cloudinary_unconfigured");
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

export type ResourceType = "image" | "video" | "raw" | "auto";

// Broad allowlist for work-item attachments (images, video, common docs).
export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".avif",
  ".mp4", ".mov", ".webm", ".m4v",
  ".pdf", ".doc", ".docx", ".txt", ".csv", ".md", ".json", ".log", ".zip",
];
export const MAX_ATTACHMENT_MB = 25;

// Validation helpers (mirrors the hyparrow ValidateFileType / ValidateFileSize).
export function validateFileType(filename: string, allowed: string[]): void {
  const ext = extname(filename).toLowerCase();
  if (!allowed.includes(ext)) {
    throw badRequest(`File type ${ext || "(none)"} not allowed`);
  }
}

export function validateFileSize(size: number, maxSizeMB: number): void {
  if (size > maxSizeMB * 1024 * 1024) {
    throw badRequest(`File exceeds the ${maxSizeMB}MB limit`);
  }
}

// Map a mime type to the Cloudinary resource type (used for upload + destroy).
export function resourceTypeForMime(mime: string): ResourceType {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return "raw";
}

// Deterministic, readable public id: "<slug>-<timestamp>".
function buildPublicId(filename: string): string {
  const base = filename
    .replace(extname(filename), "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "file"}-${Date.now()}`;
}

export interface UploadOptions {
  folder?: string;
  resourceType?: ResourceType;
  tags?: string[];
  filename?: string; // used to derive the public id
  publicId?: string; // explicit public id (stable per entity, e.g. avatars)
}

// Upload an in-memory buffer to a structured Cloudinary folder with tags.
export function uploadBuffer(buffer: Buffer, options: UploadOptions = {}): Promise<UploadApiResponse> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder ?? env.CLOUDINARY_UPLOAD_FOLDER,
        resource_type: options.resourceType ?? "auto",
        public_id: options.publicId ?? (options.filename ? buildPublicId(options.filename) : undefined),
        tags: options.tags,
        overwrite: true,
        unique_filename: false,
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error("Upload failed"));
        resolve(result);
      },
    );
    stream.end(buffer);
  });
}

// Best-effort delete from Cloudinary (used on attachment removal + save-failure cleanup).
// `type` matters for assets we stored as "authenticated" (database backups) —
// destroy scopes by delivery type and silently no-ops on a mismatch.
export async function destroyAsset(
  publicId: string,
  resourceType: ResourceType = "image",
  type: "upload" | "authenticated" | "private" = "upload",
): Promise<void> {
  ensureConfigured();
  await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType === "auto" ? "image" : resourceType,
    type,
  });
}

// Is Cloudinary usable at all? Lets the UI explain *why* a backup went to local
// disk instead of failing mysteriously.
export function isCloudinaryConfigured(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

export interface UploadFileOptions {
  folder: string;
  publicId: string;
  tags?: string[];
  /** "authenticated" keeps the asset off the public CDN — required for dumps. */
  type?: "upload" | "authenticated";
}

// Upload a file *from disk* in chunks. Database dumps are far too large to read
// into a Buffer the way uploadBuffer does, and upload_large resumes per chunk
// rather than restarting a multi-hundred-megabyte POST.
export function uploadFile(filePath: string, options: UploadFileOptions): Promise<UploadApiResponse> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(
      filePath,
      {
        folder: options.folder,
        public_id: options.publicId,
        resource_type: "raw",
        type: options.type ?? "authenticated",
        tags: options.tags,
        overwrite: true,
        unique_filename: false,
        use_filename: false,
        chunk_size: 20 * 1024 * 1024,
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error("Upload failed"));
        resolve(result as UploadApiResponse);
      },
    );
  });
}

// Short-lived signed link to an "authenticated" raw asset. The browser can
// follow it directly (no bearer token), and it expires, so a leaked link
// doesn't hand someone a permanent copy of a production database.
export function signedDownloadUrl(
  publicId: string,
  format: string,
  ttlSeconds: number,
  attachmentFilename?: string,
): string {
  ensureConfigured();
  return cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "raw",
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    attachment: attachmentFilename ?? true,
  } as Parameters<typeof cloudinary.utils.private_download_url>[2]);
}

export { cloudinary };
