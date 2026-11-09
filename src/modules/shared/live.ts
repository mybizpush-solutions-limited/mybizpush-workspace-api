import { emitToUser } from "../../realtime/events";

// Hints for connected apps. Both are safe to miss: the next sync pull or badge
// fetch recovers the same information.

export function syncHint(userIds: Iterable<string | null | undefined>, collections: string[]): void {
  const unique = new Set<string>();
  for (const id of userIds) if (id) unique.add(id);
  for (const id of unique) emitToUser(id, "sync:changed", { collections });
}

// Recompute the tab bar counts and send them. Loaded lazily because the home
// service pulls in most of the domain.
export function refreshBadges(userIds: Iterable<string | null | undefined>): void {
  const unique = new Set<string>();
  for (const id of userIds) if (id) unique.add(id);
  if (!unique.size) return;
  void import("../me/home.service")
    .then(async ({ homeService }) => {
      for (const id of unique) emitToUser(id, "badges", await homeService.badges(id));
    })
    .catch((err) => console.error("[realtime] badges not refreshed", err));
}
