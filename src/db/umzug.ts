import { Umzug, SequelizeStorage } from "umzug";
import type { QueryInterface } from "sequelize";
import { sequelize } from "./sequelize";

// Umzug drives our migrations (the engine sequelize-cli is built on). Migration
// files live in ./migrations and are plain TypeScript, run via tsx.
export const migrator = new Umzug({
  migrations: { glob: ["migrations/*.ts", { cwd: __dirname }] },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: "sequelize_meta" }),
  logger: console,
});

export type Migration = (params: { context: QueryInterface }) => Promise<void>;
