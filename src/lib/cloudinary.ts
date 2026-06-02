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
}

// Upload an in-memory buffer to a structured Cloudinary folder with tags.
export function uploadBuffer(buffer: Buffer, options: UploadOptions = {}): Promise<UploadApiResponse> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder ?? env.CLOUDINARY_UPLOAD_FOLDER,
        resource_type: options.resourceType ?? "auto",
        public_id: options.filename ? buildPublicId(options.filename) : undefined,
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
export async function destroyAsset(publicId: string, resourceType: ResourceType = "image"): Promise<void> {
  ensureConfigured();
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType === "auto" ? "image" : resourceType });
}

export { cloudinary };
