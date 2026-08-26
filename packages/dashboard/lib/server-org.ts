import { cookies } from "next/headers";
import { ORG_COOKIE, resolveOrg } from "./org-selection";

/**
 * #498 — resolve the active installation for a server-rendered page.
 *
 * Every dashboard page carried its own copy of this:
 *
 *     const activeInstallation = orgParam
 *       ? installations.find((i) => String(i.id) === orgParam) ?? installations[0]
 *       : installations[0];
 *
 * Eight copies, none of which read the cookie. The first pass at #498 fixed
 * `DashboardShell`, so the switcher held the selection while every page below
 * it still resolved from the param alone and fell back to the personal
 * account — the switcher said one org and the content showed another, which
 * is worse than the original bug because it looks authoritative.
 *
 * Kept as one helper so the next page added cannot reintroduce the split.
 * The decision itself lives in `resolveOrg`, which is pure and unit-tested;
 * this is the glue that gives it the cookie.
 */
export async function resolveActiveInstallation<T extends { id: number }>(opts: {
  installations: readonly T[];
  orgParam: string | undefined;
  githubUserId: string | undefined;
}): Promise<T> {
  const cookieValue = (await cookies()).get(ORG_COOKIE)?.value;
  const { installationId } = resolveOrg({
    orgParam: opts.orgParam,
    cookieValue,
    userId: opts.githubUserId,
    installations: opts.installations,
  });
  return (
    opts.installations.find((i) => i.id === installationId) ?? opts.installations[0]
  );
}
