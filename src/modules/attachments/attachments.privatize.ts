import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { moveToAuthenticated, resourceTypeForMime } from "../../lib/cloudinary";
import { Attachment } from "../../models";
import { isPrivateFileType } from "./attachments.service";

// Moves files uploaded before private delivery behind signed links (API-CHANGES A1003).
// Moving a file ends its public link, so nothing happens without `apply`, and a failure
// on one file leaves that file public and carries on.

export interface Moved {
  secureUrl: string;
  resourceType: string;
  format: string | null;
}
export type Mover = (publicId: string, guess: string) => Promise<Moved>;

export interface PrivatizeResult {
  applied: boolean;
  found: number;
  moved: number;
  failed: { id: string; error: string }[];
  skippedNoPublicId: number;
  byType: Record<string, number>;
}

export async function privatizeAttachments(opts: { apply: boolean; limit?: number; move?: Mover }): Promise<PrivatizeResult> {
  const move = opts.move ?? moveToAuthenticated;
  const rows = await Attachment.findAll({ where: { delivery: "upload", publicId: { [Op.ne]: null } }, order: [["createdAt", "ASC"]] });
  const candidates = rows.filter((a) => isPrivateFileType(a.itemType));
  const chosen = opts.limit ? candidates.slice(0, opts.limit) : candidates;
  const byType: Record<string, number> = {};
  for (const a of chosen) byType[a.itemType] = (byType[a.itemType] ?? 0) + 1;
  const noPublicId = await Attachment.count({ where: { delivery: "upload", publicId: null } });
  const out: PrivatizeResult = { applied: opts.apply, found: chosen.length, moved: 0, failed: [], skippedNoPublicId: noPublicId, byType };
  if (!opts.apply) return out;

  for (const a of chosen) {
    try {
      const moved = await move(a.publicId!, a.resourceType ?? resourceTypeForMime(a.type));
      await a.update({ delivery: "authenticated", url: moved.secureUrl, resourceType: moved.resourceType, format: moved.format });
      await refreshCopies(a);
      out.moved++;
    } catch (err) {
      out.failed.push({ id: a.id, error: (err as Error).message });
    }
  }
  return out;
}

// Messages keep a copy of each file's details, and devices hold the old public link in
// the task or issue they synced. Touching those rows brings the new link to them.
async function refreshCopies(a: Attachment): Promise<void> {
  const held = JSON.stringify([{ id: a.id }]);
  const asset = JSON.stringify({ publicId: a.publicId, delivery: "authenticated", resourceType: a.resourceType, format: a.format });
  const messages = await sequelize.query<{ id: string; meta: { attachments: { id: string }[] } }>(`SELECT id, meta FROM messages WHERE meta->'attachments' @> CAST(:held AS jsonb)`, {
    replacements: { held },
    type: QueryTypes.SELECT,
  });
  for (const m of messages) {
    const attachments = m.meta.attachments.map((f) => (f.id === a.id ? { ...f, url: a.url, asset: JSON.parse(asset) as unknown } : f));
    await sequelize.query(`UPDATE messages SET meta = CAST(:meta AS jsonb), updated_at = now() WHERE id = :id`, { replacements: { id: m.id, meta: JSON.stringify({ ...m.meta, attachments }) } });
  }
  if (a.itemType === "task") await sequelize.query(`UPDATE tasks SET updated_at = now() WHERE id = :id`, { replacements: { id: a.itemId } });
  if (a.itemType === "issue") await sequelize.query(`UPDATE issues SET updated_at = now() WHERE id = :id`, { replacements: { id: a.itemId } });
}
