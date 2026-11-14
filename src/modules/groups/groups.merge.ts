// Merging group membership into a de-duplicated list of people (API-CHANGES A204,
// A403). Pure so it can be unit tested. Each person keeps which groups brought
// them in, so the review list can explain why someone is on it.

export const GROUP_TYPES = ["team", "department", "product", "project"] as const;
export type GroupType = (typeof GROUP_TYPES)[number];
export interface GroupRef {
  type: GroupType;
  id: string;
}

export function mergeGroupMembers(
  groups: { ref: GroupRef; userIds: string[] }[],
  excludeUserIds: readonly string[] = [],
): { userId: string; via: GroupRef[] }[] {
  const excluded = new Set(excludeUserIds);
  const merged = new Map<string, GroupRef[]>();
  for (const { ref, userIds } of groups) {
    for (const userId of new Set(userIds)) {
      if (excluded.has(userId)) continue;
      const via = merged.get(userId);
      if (via) via.push(ref);
      else merged.set(userId, [ref]);
    }
  }
  return [...merged].map(([userId, via]) => ({ userId, via }));
}
