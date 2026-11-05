import { registerJob } from "../workers";

// A no-op job used to check the pipeline end to end: enqueue it from the admin
// endpoint (POST /api/v1/jobs/ping) and watch it complete in /jobs/stats.
registerJob<{ requestedBy?: string }>("maintenance", "ping", async (data) => {
  console.info(`[jobs] ping from ${data.requestedBy ?? "unknown"}`);
});
