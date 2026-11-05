// Models the staff module uses, in one place. DeviceToken lives on the push
// branch (A003); until both are merged the import is optional, so suspension
// disables push tokens when the table exists and is a no-op otherwise.
import { sequelize } from "../../db/sequelize";

export {
  AccessAssignment,
  AccessRole,
  Department,
  Invitation,
  Product,
  ProductMember,
  Team,
  User,
  type EmploymentStatus,
} from "../../models";

type Updatable = { update: (values: object, opts: object) => Promise<unknown> };

export const DeviceTokenLike: Updatable = {
  update: async (values: object, opts: object) => {
    const model = sequelize.models.DeviceToken as unknown as Updatable | undefined;
    if (!model) return [0];
    return model.update(values, opts);
  },
};
