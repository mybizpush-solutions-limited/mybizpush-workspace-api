import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";

// Store the Cloudinary public_id so attachments can be deleted from Cloudinary.
export const up: Migration = async ({ context: qi }) => {
  await qi.addColumn("attachments", "public_id", { type: DataTypes.STRING, allowNull: true });
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("attachments", "public_id");
};
