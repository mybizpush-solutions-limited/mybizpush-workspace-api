import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Projects become independent and worked on by many departments. Add the
// project_departments join + a department "lane" on tasks/issues/repos, and
// back-fill everything from each project's original (single) department.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("project_departments", {
      project_id: { type: DataTypes.UUID, allowNull: false, references: { model: "projects", key: "id" }, onDelete: "CASCADE" },
      department_id: { type: DataTypes.UUID, allowNull: false, references: { model: "departments", key: "id" }, onDelete: "CASCADE" },
    }),
  );
  await ignoreDuplicate(qi.addConstraint("project_departments", { fields: ["project_id", "department_id"], type: "primary key", name: "project_departments_pkey" }));

  await ignoreDuplicate(qi.addColumn("tasks", "department_id", { type: DataTypes.UUID, allowNull: true }));
  await ignoreDuplicate(qi.addColumn("issues", "department_id", { type: DataTypes.UUID, allowNull: true }));
  await ignoreDuplicate(qi.addColumn("project_repos", "department_id", { type: DataTypes.UUID, allowNull: true }));

  // Back-fill: each project's original department becomes its first lane, and
  // its existing tasks/issues/repos inherit that lane.
  await qi.sequelize.query(`
    INSERT INTO project_departments (project_id, department_id)
    SELECT id, department_id FROM projects WHERE department_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await qi.sequelize.query(`UPDATE tasks t SET department_id = p.department_id FROM projects p WHERE t.project_id = p.id AND t.department_id IS NULL`);
  await qi.sequelize.query(`UPDATE issues i SET department_id = p.department_id FROM projects p WHERE i.project_id = p.id AND i.department_id IS NULL`);
  await qi.sequelize.query(`UPDATE project_repos r SET department_id = p.department_id FROM projects p WHERE r.project_id = p.id AND r.department_id IS NULL`);

  // Projects are now independent — drop the NOT NULL on the legacy home dept.
  await ignoreDuplicate(qi.changeColumn("projects", "department_id", { type: DataTypes.UUID, allowNull: true }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("project_departments");
  await qi.removeColumn("tasks", "department_id");
  await qi.removeColumn("issues", "department_id");
  await qi.removeColumn("project_repos", "department_id");
};
