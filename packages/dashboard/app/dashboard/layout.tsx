import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchUserInstallations, TokenExpiredError } from "@/lib/github-repos";
import DashboardShell from "@/components/layout/DashboardShell";
import type { InstallationInfo } from "@/components/layout/DashboardShell";
import { ORG_COOKIE } from "@/lib/org-selection";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/");
  }

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) {
    redirect("/");
  }

  let installations;
  try {
    installations = await fetchUserInstallations(accessToken);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      redirect("/signout");
    }
    throw err;
  }

  if (installations.length === 0) {
    redirect("/onboarding");
  }

  const installationInfos: InstallationInfo[] = installations.map((i) => ({
    id: i.id,
    login: i.account.login,
    avatarUrl: i.account.avatar_url,
    type: i.account.type,
  }));

  // #498 — read the selection server-side so the correct org renders on first
  // paint. Resolving it in the client would render the default on the server
  // and correct it on hydration, flipping the switcher on every page load.
  const orgCookie = (await cookies()).get(ORG_COOKIE)?.value;

  return (
    <DashboardShell
      userName={session.user?.name ?? session.user?.email ?? ""}
      userImage={session.user?.image}
      installations={installationInfos}
      orgCookie={orgCookie}
      githubUserId={(session as any).githubUserId as string | undefined}
    >
      {children}
    </DashboardShell>
  );
}
