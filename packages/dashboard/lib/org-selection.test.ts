import { describe, it, expect } from "vitest";
import {
  ORG_COOKIE,
  serializeOrgCookie,
  serializeClearedOrgCookie,
  parseOrgCookie,
  resolveOrg,
} from "./org-selection";

const INSTALLS = [{ id: 111 }, { id: 222 }, { id: 333 }];
const USER = "9001";

describe("serializeOrgCookie", () => {
  it("round-trips through parseOrgCookie", () => {
    const raw = serializeOrgCookie(USER, 222).split(";")[0].slice(ORG_COOKIE.length + 1);
    expect(parseOrgCookie(raw)).toEqual({ userId: USER, installationId: 222 });
  });

  it("scopes to the path and uses Lax so a top-level navigation still carries it", () => {
    const c = serializeOrgCookie(USER, 222);
    expect(c).toContain("Path=/");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=");
  });

  it("adds Secure only when asked", () => {
    expect(serializeOrgCookie(USER, 222, { secure: true })).toContain("; Secure");
    expect(serializeOrgCookie(USER, 222, { secure: false })).not.toContain("Secure");
    // Default is the safe-for-plain-HTTP form: a self-hosted deployment runs a
    // production build over HTTP, and an inert Secure cookie there would
    // silently break the switcher.
    expect(serializeOrgCookie(USER, 222)).not.toContain("Secure");
  });

  it("still round-trips with Secure set", () => {
    const raw = serializeOrgCookie(USER, 222, { secure: true }).split(";")[0].slice(ORG_COOKIE.length + 1);
    expect(parseOrgCookie(raw)).toEqual({ userId: USER, installationId: 222 });
  });

  it("expires immediately when cleared", () => {
    expect(serializeClearedOrgCookie()).toContain("Max-Age=0");
  });
});

describe("parseOrgCookie", () => {
  it("returns null for absent values", () => {
    expect(parseOrgCookie(undefined)).toBeNull();
    expect(parseOrgCookie(null)).toBeNull();
    expect(parseOrgCookie("")).toBeNull();
  });

  it("returns null for malformed values rather than a partial selection", () => {
    expect(parseOrgCookie("nocolon")).toBeNull();
    expect(parseOrgCookie(":222")).toBeNull();
    expect(parseOrgCookie("9001:")).toBeNull();
    expect(parseOrgCookie("9001:abc")).toBeNull();
    expect(parseOrgCookie("9001:-5")).toBeNull();
    expect(parseOrgCookie("9001:0")).toBeNull();
    expect(parseOrgCookie("9001:1.5")).toBeNull();
  });

  it("does not throw on an undecodable value", () => {
    expect(parseOrgCookie("%E0%A4%A")).toBeNull();
  });

  it("splits on the last colon so a colon in the user id cannot shift the install id", () => {
    expect(parseOrgCookie("we:ird:222")).toEqual({ userId: "we:ird", installationId: 222 });
  });
});

describe("resolveOrg", () => {
  const base = { orgParam: null, cookieValue: null, userId: USER, installations: INSTALLS };

  it("prefers the URL param so a shared deep link wins", () => {
    const r = resolveOrg({ ...base, orgParam: "333", cookieValue: `${USER}:222` });
    expect(r).toEqual({ installationId: 333, source: "param", staleCookie: false });
  });

  it("falls back to the cookie when no param is present", () => {
    const r = resolveOrg({ ...base, cookieValue: `${USER}:222` });
    expect(r).toEqual({ installationId: 222, source: "cookie", staleCookie: false });
  });

  it("falls back to the first installation when there is no selection at all", () => {
    expect(resolveOrg(base)).toEqual({ installationId: 111, source: "default", staleCookie: false });
  });

  it("ignores a cookie belonging to another user — the shared-browser case", () => {
    const r = resolveOrg({ ...base, cookieValue: `4242:222` });
    expect(r.installationId).toBe(111);
    expect(r.source).toBe("default");
    expect(r.staleCookie).toBe(true);
  });

  it("ignores a cookie naming an installation the user can no longer access", () => {
    const r = resolveOrg({ ...base, cookieValue: `${USER}:999` });
    expect(r.installationId).toBe(111);
    expect(r.source).toBe("default");
    expect(r.staleCookie).toBe(true);
  });

  it("marks a malformed cookie stale so it stops being re-read", () => {
    const r = resolveOrg({ ...base, cookieValue: "garbage" });
    expect(r.staleCookie).toBe(true);
  });

  it("does not mark an absent cookie stale", () => {
    expect(resolveOrg(base).staleCookie).toBe(false);
  });

  it("ignores a cookie when the session has no user id", () => {
    const r = resolveOrg({ ...base, userId: undefined, cookieValue: `${USER}:222` });
    expect(r.installationId).toBe(111);
    expect(r.staleCookie).toBe(true);
  });

  it("ignores a param naming an installation the user does not have", () => {
    const r = resolveOrg({ ...base, orgParam: "999", cookieValue: `${USER}:222` });
    expect(r).toEqual({ installationId: 222, source: "cookie", staleCookie: false });
  });

  it("ignores a non-numeric param", () => {
    expect(resolveOrg({ ...base, orgParam: "abc" }).source).toBe("default");
    expect(resolveOrg({ ...base, orgParam: "" }).source).toBe("default");
  });

  it("rejects a non-positive param outright", () => {
    expect(resolveOrg({ ...base, orgParam: "0" }).source).toBe("default");
    expect(resolveOrg({ ...base, orgParam: "-111" }).source).toBe("default");
  });

  it("reports no selection when the user has no installations", () => {
    const r = resolveOrg({ ...base, installations: [] });
    expect(r).toEqual({ installationId: null, source: "none", staleCookie: false });
  });

  it("does NOT flag a valid cookie as stale when a param outranks it", () => {
    // The param wins and DashboardShell overwrites the cookie (source is
    // "param", which its write condition covers). Flagging this stale would
    // clear a perfectly good cookie on every deep-link visit.
    const r = resolveOrg({ ...base, orgParam: "333", cookieValue: `${USER}:222` });
    expect(r).toEqual({ installationId: 333, source: "param", staleCookie: false });
  });

  it("still reports a stale cookie when a valid param wins — the caller must drop it", () => {
    // DashboardShell clears on this flag alone; it must not be suppressed just
    // because the param resolved the org.
    const r = resolveOrg({ ...base, orgParam: "333", cookieValue: "4242:222" });
    expect(r.source).toBe("param");
    expect(r.installationId).toBe(333);
    expect(r.staleCookie).toBe(true);
  });

  it("keeps a valid cookie usable even when a stale param is present", () => {
    const r = resolveOrg({ ...base, orgParam: "0", cookieValue: `${USER}:333` });
    expect(r.installationId).toBe(333);
    expect(r.source).toBe("cookie");
  });
});
