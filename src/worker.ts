import { assertDbConnection, sequelize } from "./db/sequelize";
import { redis } from "./redis/client";
import { closeQueues, startWorkers, stopWorkers } from "./jobs";
// Importing the models registers them with Sequelize and wires associations.
import "./models";

// Standalone worker process: runs background jobs without serving HTTP. Use it
// when the API runs with RUN_JOB_WORKERS=false so web traffic and heavy jobs
// (imports, exports, campaign sends) scale separately.
async function start() {
  await assertDbConnection();
  console.info("✓ Database connected (worker)");
  startWorkers();

  const shutdown = async (signal: string) => {
    console.info(`\n${signal} received — stopping workers…`);
    await stopWorkers();
    await closeQueues();
    await Promise.allSettled([sequelize.close(), redis.quit()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});
