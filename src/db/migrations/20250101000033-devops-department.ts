import type { Migration } from "../umzug";

// DevOps is both a functional role and a department. The department is what
// the server console's access rule keys on (alongside the role), so it has to
// exist in every environment, not only where the seed ran. Head is left unset —
// an executive admin assigns one from the workspace UI.
export const up: Migration = async ({ context: qi }) => {
  await qi.sequelize.query(`
    INSERT INTO departments (id, slug, name, description, head_id, created_at, updated_at)
    VALUES (
      gen_random_uuid(), 'devops', 'DevOps',
      'Servers, deployments, patching and infrastructure security.', NULL, NOW(), NOW()
    )
    ON CONFLICT (slug) DO NOTHING
  `);
};

// Only remove it if nobody has joined it and it owns no projects, so a rollback
// can't take real data with it.
export const down: Migration = async ({ context: qi }) => {
  await qi.sequelize.query(`
    DELETE FROM departments d
    WHERE d.slug = 'devops'
      AND NOT EXISTS (SELECT 1 FROM department_members m WHERE m.department_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM project_departments pd WHERE pd.department_id = d.id)
  `);
};
