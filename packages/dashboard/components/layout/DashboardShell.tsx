"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Sidenav from "./Sidenav";
import {
  resolveOrg,
  writeOrgCookie,
  serializeClearedOrgCookie,
} from "@/lib/org-selection";

export interface InstallationInfo {
  id: number;
  login: string;
  avatarUrl: string;
  type: "User" | "Organization";
}

interface DashboardShellProps {
  userName: string;
  userImage?: string | null;
  installations: InstallationInfo[];
  /** #498 — raw `mw_org` cookie, read server-side so first paint is correct. */
  orgCookie?: string;
  /** #498 — session user, so another account's cookie cannot select an org. */
  githubUserId?: string;
  children: React.ReactNode;
}

export default function DashboardShell({
  userName,
  userImage,
  installations,
  orgCookie,
  githubUserId,
  children,
}: DashboardShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const orgParam = searchParams.get("org");

  // #498 — `?org=` wins (deep links), then the cookie, then the first
  // installation. Both candidates are validated against the installations this
  // account actually has: access can be revoked between visits, and resolving
  // a stale id anyway would show one org's label over another org's data.
  const resolved = resolveOrg({
    orgParam,
    cookieValue: orgCookie,
    userId: githubUserId,
    installations,
  });

  const activeInstallation =
    installations.find((i) => i.id === resolved.installationId) ??
    installations[0];

  // Persist whatever resolved, and drop a cookie that can never resolve. A
  // stale one is otherwise re-read on every navigation for the life of the
  // browser profile. Writing on `param` is what makes a shared deep link
  // switch the reader's session to the org it names.
  useEffect(() => {
    if (typeof document === "undefined") return;
    // Cleared unconditionally, then re-written below when there is something
    // to write. Guarding this on `source !== "param"` relied on the write
    // always following, but its own guard can fail (a session with no
    // githubUserId), and the stale cookie then survived indefinitely.
    if (resolved.staleCookie) {
      document.cookie = serializeClearedOrgCookie();
    }
    // `!== "cookie"` rather than `=== "param"`: it must also fire for
    // `"default"`, or a first-time visitor's org is never persisted and the
    // original bug returns for anyone who has not used the switcher yet.
    // A param that beats a valid, different cookie is already covered here —
    // source is "param", so the write runs and overwrites it. The one path
    // that skips the write is a session with no githubUserId, and that same
    // condition makes the cookie unusable in resolveOrg, so it is cleared
    // above instead of being left to disagree with the URL.
    if (githubUserId && resolved.installationId != null && resolved.source !== "cookie") {
      writeOrgCookie(githubUserId, resolved.installationId);
    }
  }, [githubUserId, resolved.installationId, resolved.source, resolved.staleCookie]);

  const handleSwitch = useCallback(
    (installationId: number) => {
      // Write before navigating: the cookie is what carries the choice to
      // pages the param never reaches, and the push below only survives as
      // long as the param does.
      if (githubUserId) {
        writeOrgCookie(githubUserId, installationId);
      }
      const params = new URLSearchParams(searchParams.toString());
      params.set("org", String(installationId));
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams, githubUserId],
  );

  return (
    <div className="flex min-h-screen">
      <Sidenav
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        onMobileOpen={() => setMobileNavOpen(true)}
        installations={installations}
        activeInstallation={activeInstallation}
        onSwitchInstallation={handleSwitch}
        userName={userName}
        userImage={userImage}
        orgParam={orgParam}
      />

      <div className="flex-1 md:ml-16 lg:ml-[240px]">
        <main>{children}</main>
      </div>
    </div>
  );
}
