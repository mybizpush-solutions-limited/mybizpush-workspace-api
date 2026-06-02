import { Umzug, SequelizeStorage } from "umzug";
import type { QueryInterface } from "sequelize";
import { sequelize } from "./sequelize";

// Umzug drives our migrations (the engine sequelize-cli is built on).
export const migrator = new Umzug({
  migrations: {
    // Matches .ts under tsx (dev) and the compiled .js in dist (production image).
    glob: ["migrations/*.{js,ts}", { cwd: __dirname }],
    // Record migrations under an extension-agnostic name so a migration applied
    // in dev (`...-x.ts`) is recognised as applied in the prod image (`...-x.js`).
    resolve: ({ name, path, context }) => {
      const normalized = name.replace(/\.(js|ts)$/, "");
      return {
        name: normalized,
        up: async () => {
          const mod = (await import(path!)) as { up: Migration };
          return mod.up({ context });
        },
        down: async () => {
          const mod = (await import(path!)) as { down?: Migration };
          return mod.down?.({ context });
        },
      };
    },
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: "sequelize_meta" }),
  logger: console,
});

export type Migration = (params: { context: QueryInterface }) => Promise<void>;
