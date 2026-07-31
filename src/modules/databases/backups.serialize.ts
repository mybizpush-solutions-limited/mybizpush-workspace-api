import type { DatabaseBackup } from "../../models";

// Kept in its own file so databases.service can render a "last backup" without
// importing backups.service (which imports databases.service right back).
export interface SerializedBackup {
  id: string;
  databaseId: string;
  projectId: string;
  status: string;
  trigger: string;
  format: string;
  storage: string;
  storageNote: string;
  fileName: string;
  fileSizeBytes: number;
  checksum: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  error: string;
  pgDumpVersion: string;
  createdBy: string | null;
  createdAt: string;
}

export function serializeBackup(b: DatabaseBackup): SerializedBackup {
  return {
    id: b.id,
    databaseId: b.databaseId,
    projectId: b.projectId,
    status: b.status,
    trigger: b.trigger,
    format: b.format,
    storage: b.storage,
    storageNote: b.storageNote,
    fileName: b.fileName,
    // BIGINT comes back from pg as a string.
    fileSizeBytes: Number(b.fileSizeBytes ?? 0),
    checksum: b.checksum,
    startedAt: b.startedAt.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
    durationMs: b.durationMs,
    error: b.error,
    pgDumpVersion: b.pgDumpVersion,
    createdBy: b.createdBy ?? null,
    createdAt: b.createdAt.toISOString(),
  };
}
