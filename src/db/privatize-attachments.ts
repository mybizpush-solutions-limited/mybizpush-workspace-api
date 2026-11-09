/**
 * Moves files uploaded before private delivery behind signed links (API-CHANGES A1003).
 *
 *   npm run attachments:privatize                        lists what would move, changes nothing
 *   npm run attachments:privatize -- --apply --limit=1   moves one, to try it safely
 *   npm run attachments:privatize -- --apply             moves the rest
 *
 * Moving a file ends its public link. See the README before running this on real data.
 */
import { sequelize } from "./sequelize";
import { isCloudinaryConfigured } from "../lib/cloudinary";
import { privatizeAttachments } from "../modules/attachments/attachments.privatize";
import "../models";

async function main() {
  const apply = process.argv.includes("--apply");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a whole number above 0");
  if (apply && !isCloudinaryConfigured()) throw new Error("Cloudinary isn't configured, so nothing can be moved");

  const result = await privatizeAttachments({ apply, limit });
  console.info(JSON.stringify(result, null, 2));
  if (!apply) console.info("Nothing was changed. Add --apply to move these files.");
  await sequelize.close();
  if (result.failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
