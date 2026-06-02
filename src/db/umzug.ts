import { Umzug, SequelizeStorage } from "umzug";
import type { QueryInterface } from "sequelize";
import { sequelize } from "./sequelize";

// Umzug drives our migrations (the engine sequelize-cli is built on). Migration
// files live in ./migrations and are plain TypeScript, run via tsx.
export const migrator = new Umzug({
  // Matches .ts under tsx (dev) and the compiled .js in dist (production image).
  migrations: { glob: ["migrations/*.{js,ts}", { cwd: __dirname }] },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: "sequelize_meta" }),
  logger: console,
});

export type Migration = (params: { context: QueryInterface }) => Promise<void>;
