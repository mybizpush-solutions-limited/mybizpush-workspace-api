import { CustomRole, ROLES } from "../../models";
import { badRequest } from "../../lib/errors";

const STANDARD: readonly string[] = ROLES;
const MAX_ROLE_LEN = 40;

export const rolesService = {
  // The effective role catalog: the built-in ROLES followed by any custom roles
  // an executive admin has added (alphabetical, de-duplicated against the
  // built-ins case-insensitively).
  async list(): Promise<string[]> {
    const custom = await CustomRole.findAll({ order: [["name", "ASC"]] });
    const seen = new Set(STANDARD.map((r) => r.toLowerCase()));
    const extra: string[] = [];
    for (const c of custom) {
      const key = c.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push(c.name);
    }
    return [...STANDARD, ...extra];
  },

  // Validate a set of roles against the catalog and return them in canonical
  // spelling (so "frontend" is stored as "Frontend"), de-duplicated. Throws on
  // any role that isn't in the catalog. Used by both self-service (/me) and the
  // exec setRoles path so storage never drifts.
  async normalize(roles: string[]): Promise<string[]> {
    const byLower = new Map((await this.list()).map((r) => [r.toLowerCase(), r]));
    const out: string[] = [];
    const seen = new Set<string>();
    const invalid: string[] = [];
    for (const raw of roles) {
      const canonical = byLower.get(raw.trim().toLowerCase());
      if (!canonical) {
        invalid.push(raw);
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(canonical);
    }
    if (invalid.length) throw badRequest(`Unknown role(s): ${invalid.join(", ")}`);
    return out;
  },

  // Exec-only: add a new role to the catalog so everyone can pick it. Idempotent
  // on case — adding a role that already exists (built-in or custom) is rejected
  // rather than creating a near-duplicate. Returns the updated catalog.
  async add(name: string, createdBy: string | null): Promise<string[]> {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest("Role name is required");
    if (trimmed.length > MAX_ROLE_LEN) {
      throw badRequest(`Role name must be ${MAX_ROLE_LEN} characters or fewer`);
    }
    const existing = await this.list();
    if (existing.some((r) => r.toLowerCase() === trimmed.toLowerCase())) {
      throw badRequest(`A role called "${trimmed}" already exists`);
    }
    await CustomRole.create({ name: trimmed, createdBy });
    return this.list();
  },
};
