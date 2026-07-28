import type { Migration } from "../umzug";

// Ensure the Marketing department exists in every environment. The dev seed
// creates it, but deployments that never ran the seed had no department for
// marketers to join during onboarding. Head is left unset — an executive admin
// assigns one from the workspace UI.
export const up: Migration = async ({ context: qi }) => {
  await qi.sequelize.query(`
    INSERT INTO departments (id, slug, name, description, head_id, created_at, updated_at)
    VALUES (
      gen_random_uuid(), 'marketing', 'Marketing',
      'Growth, social media, and campaigns.', NULL, NOW(), NOW()
    )
    ON CONFLICT (slug) DO NOTHING
  `);
};

// Only remove it if nobody has joined it and it owns no projects, so a rollback
// can't take real data with it.
export const down: Migration = async ({ context: qi }) => {
  await qi.sequelize.query(`
    DELETE FROM departments d
    WHERE d.slug = 'marketing'
      AND NOT EXISTS (SELECT 1 FROM department_members m WHERE m.department_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.department_id = d.id)
  `);
};
