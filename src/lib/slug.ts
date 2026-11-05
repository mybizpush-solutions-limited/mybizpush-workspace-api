import { Op, type ModelStatic, type Model } from "sequelize";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 100) || "item"
  );
}

// A slug not yet used in `model`: "hempay", then "hempay-2", "hempay-3"...
export async function uniqueSlug(model: ModelStatic<Model>, name: string, exceptId?: string): Promise<string> {
  const base = slugify(name);
  const rows = await model.findAll({
    where: { slug: { [Op.like]: `${base}%` }, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
    attributes: ["slug"],
  });
  const taken = new Set(rows.map((r) => r.get("slug") as string));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
