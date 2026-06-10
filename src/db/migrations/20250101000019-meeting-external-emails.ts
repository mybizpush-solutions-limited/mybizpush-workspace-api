import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Third-party invitees (by email) on a meeting — people who aren't app users but
// are added to the Google Calendar invite (e.g. a client or vendor).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("meetings", "external_emails", {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: [],
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("meetings", "external_emails");
};
