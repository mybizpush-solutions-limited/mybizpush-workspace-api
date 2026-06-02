import { Sequelize } from "sequelize";
import { env, isProd } from "../config/env";

// Single shared Sequelize instance, configured from DATABASE_URL.
export const sequelize = new Sequelize(env.DATABASE_URL, {
  dialect: "postgres",
  logging: isProd ? false : (msg) => process.env.SQL_LOG && console.debug(msg),
  pool: { max: 10, min: 0, idle: 30_000 },
  define: {
    underscored: true, // camelCase attributes ↔ snake_case columns
    timestamps: true,
  },
});

export async function assertDbConnection(): Promise<void> {
  await sequelize.authenticate();
}
