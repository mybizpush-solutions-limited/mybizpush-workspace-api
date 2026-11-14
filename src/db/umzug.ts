import { Umzug, SequelizeStorage } from "umzug";
import type { QueryInterface } from "sequelize";
import { sequelize } from "./sequelize";

// require() rather than import(): the code compiles to CommonJS anyway, and under
// tsx on Windows import() rejects absolute paths like C:\... as invalid URLs.
function loadMigration(path: string): { up: Migration; down?: Migration } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as { up: Migration; down?: Migration };
}

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
          const mod = loadMigration(path!);
          return mod.up({ context });
        },
        down: async () => {
          const mod = loadMigration(path!);
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
