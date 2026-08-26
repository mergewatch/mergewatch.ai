/**
 * #498 — organization selection that survives navigation.
 *
 * The selection used to live only in the URL (`?org=`), so any link that
 * forgot the param reset it. `DashboardShell` fell back to `installations[0]`
 * — the personal account for most users — which turned a missing param into a
 * wrong answer rather than a visible one.
 *
 * The selection now lives in a cookie. A cookie rather than localStorage
 * because the dashboard is server-rendered (`force-dynamic` throughout): a
 * client-only store would render the default org on the server and correct it
 * on hydration, flipping the switcher on every page load. The server can read
 * a cookie, so the right org renders on first paint.
 *
 * The URL param stays as a deep-link override and wins when present, so a
 * shared link switches the reader to the org it names.
 */

/** Cookie name. Short and namespaced; the value is not a secret. */
export const ORG_COOKIE = "mw_org";

/** One year. The user-scoping check below is what bounds validity, not this. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface OrgCookie {
  /** GitHub user id that made the selection. */
  userId: string;
  /** Selected GitHub App installation id. */
  installationId: number;
}

/** Where the resolved selection came from. */
export type OrgSource = "param" | "cookie" | "default" | "none";

export interface ResolvedOrg {
  /** Installation id to treat as active, or null when there is nothing to show. */
  installationId: number | null;
  source: OrgSource;
  /**
   * True when a cookie was present but unusable — wrong user, revoked
   * installation, or malformed. The caller drops it instead of letting a
   * value that can never resolve keep being read on every navigation.
   */
  staleCookie: boolean;
}

/**
 * Serialize the selection with its owning user.
 *
 * The user id is stored alongside the installation id so a cookie belonging
 * to a different account is inert by construction. Clearing on sign-out is
 * hygiene; this check is the guarantee — a missed clear, a shared browser, or
 * a cookie left by a previous account cannot select an org for someone else.
 */
export function serializeOrgCookie(userId: string, installationId: number): string {
  const value = encodeURIComponent(`${userId}:${installationId}`);
  return `${ORG_COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

/** Serialize the expiry form used on sign-out. */
export function serializeClearedOrgCookie(): string {
  return `${ORG_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Parse a cookie value. Returns null for anything malformed — an unparseable
 * cookie is treated as absent, never as a partial selection.
 */
export function parseOrgCookie(raw: string | undefined | null): OrgCookie | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // rsplit on the LAST colon: GitHub user ids are numeric today, but a colon
  // in the user portion must not silently shift the installation id.
  const sep = decoded.lastIndexOf(":");
  if (sep <= 0) return null;
  const userId = decoded.slice(0, sep);
  const installationId = Number(decoded.slice(sep + 1));
  if (!userId || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return null;
  }
  return { userId, installationId };
}

/**
 * Resolve which installation is active.
 *
 * Precedence: `?org=` param → cookie → first installation.
 *
 * Both the param and the cookie are validated against the installations the
 * user actually has. Access can be revoked between visits, so a stored id can
 * name an org this account can no longer see; resolving it anyway would show
 * one org's label over another org's data.
 *
 * `source` is returned so the caller can tell a real selection from a
 * fallback. Falling back to the first installation is right for someone who
 * has never chosen — it is only misleading when it silently replaces a
 * selection that has become invalid, and `staleCookie` marks that case.
 */
export function resolveOrg(opts: {
  orgParam: string | null | undefined;
  cookieValue: string | undefined | null;
  userId: string | undefined | null;
  installations: readonly { id: number }[];
}): ResolvedOrg {
  const { orgParam, cookieValue, userId, installations } = opts;
  const has = (id: number) => installations.some((i) => i.id === id);

  const cookie = parseOrgCookie(cookieValue);
  const cookieUsable = !!cookie && !!userId && cookie.userId === userId && has(cookie.installationId);
  // Keyed on the raw value, not the parsed one: a cookie that is present but
  // unparseable is just as stale as one naming a revoked installation, and
  // testing `cookie` here would leave a corrupt value to be re-read on every
  // navigation forever. Covers the wrong-user (shared browser), revoked-access
  // and malformed cases alike.
  const cookiePresent = typeof cookieValue === "string" && cookieValue.length > 0;
  const staleCookie = cookiePresent && !cookieUsable;

  const paramId = orgParam == null || orgParam === "" ? NaN : Number(orgParam);
  if (Number.isSafeInteger(paramId) && has(paramId)) {
    return { installationId: paramId, source: "param", staleCookie };
  }

  if (cookieUsable) {
    return { installationId: cookie!.installationId, source: "cookie", staleCookie: false };
  }

  const first = installations[0]?.id;
  if (first === undefined) {
    return { installationId: null, source: "none", staleCookie };
  }
  return { installationId: first, source: "default", staleCookie };
}

/**
 * Drop the selection. Called on sign-out so one account's choice does not
 * greet the next person on a shared browser.
 *
 * This is hygiene, not the correctness boundary — `resolveOrg` ignores a
 * cookie whose user does not match the session, so a missed clear is inert.
 * Belt and braces, deliberately.
 */
export function clearOrgCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = serializeClearedOrgCookie();
}
