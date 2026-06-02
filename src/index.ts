import { createApp } from "./app";
import { env } from "./config/env";
import { assertDbConnection, sequelize } from "./db/sequelize";
import { redis } from "./redis/client";
import { startDigestScheduler } from "./modules/digests/digests.scheduler";
// Importing the models registers them with Sequelize and wires associations.
import "./models";

async function start() {
  await assertDbConnection();
  console.info("✓ Database connected");

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.info(`🚀 MyBizPush Dev Space API listening on http://localhost:${env.PORT}`);
  });

  startDigestScheduler();

  const shutdown = async (signal: string) => {
    console.info(`\n${signal} received — shutting down…`);
    server.close();
    await Promise.allSettled([sequelize.close(), redis.quit()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
