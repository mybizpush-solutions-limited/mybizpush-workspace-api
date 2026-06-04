import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Structured recurrence rule for repeating meetings (null = one-off). Translated
// to an iCalendar RRULE for the Google Calendar event.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("meetings", "recurrence", { type: DataTypes.JSONB, allowNull: true }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("meetings", "recurrence");
};
