import { migrator } from "./umzug";
import { sequelize } from "./sequelize";

// CLI entry: `npm run migrate` runs all pending migrations.
// `npm run migrate -- down` rolls back the most recent one.
async function main() {
  const direction = process.argv[2] === "down" ? "down" : "up";
  if (direction === "down") {
    await migrator.down();
  } else {
    const pending = await migrator.pending();
    if (pending.length === 0) {
      console.info("✅ No pending migrations");
    } else {
      await migrator.up();
    }
  }
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
