import { badRequest } from "./errors";
import { uploadBuffer } from "./cloudinary";

const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const MAX_MB = 8;

export interface UploadFile {
  buffer: Buffer;
  originalname: string;
  size: number;
  mimetype: string;
}

// Validate an uploaded image and push it to Cloudinary, returning the URL.
// `publicId` is stable per-entity so re-uploads overwrite the previous image.
export async function uploadAvatarImage(
  file: UploadFile,
  opts: { folder: string; publicId: string; tags?: string[] },
): Promise<string> {
  const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw badRequest(`Image must be one of: ${ALLOWED_EXTENSIONS.join(", ")}`);
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    throw badRequest(`Image must be ${MAX_MB}MB or smaller`);
  }
  const result = await uploadBuffer(file.buffer, {
    folder: opts.folder,
    resourceType: "image",
    tags: opts.tags ?? [],
    publicId: opts.publicId,
  });
  return result.secure_url;
}
