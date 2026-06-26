export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  fetchUserInstallations,
  fetchInstallationRepos,
  checkInstallationAdmin,
  TokenExpiredError,
} from "@/lib/github-repos";
import CustomAgentsManager from "@/components/CustomAgentsManager";

interface Props {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * /dashboard/settings/custom-agents (#235) — org admins define custom review
 * agents enforced across the org's repos. Members see a read-only view.
 */
export default async function CustomAgentsPage({ searchParams }: Props) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");
  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) redirect("/");

  const params = await searchParams;
  let installations;
  try {
    installations = await fetchUserInstallations(accessToken);
  } catch (err) {
    if (err instanceof TokenExpiredError) redirect("/signout");
    throw err;
  }
  if (installations.length === 0) redirect("/onboarding");

  const orgParam = typeof params.org === "string" ? params.org : undefined;
  const activeInstallation = orgParam
    ? installations.find((i) => String(i.id) === orgParam) ?? installations[0]
    : installations[0];

  const isAdmin = await checkInstallationAdmin(accessToken, activeInstallation);

  // Repo list powers the "selected repos" scope picker. Best-effort — the page
  // still works (all-repos scope) if the repo fetch fails.
  let repoNames: string[] = [];
  try {
    const { repos } = await fetchInstallationRepos(accessToken, activeInstallation.id);
    repoNames = repos.map((r) => r.repoFullName).sort();
  } catch {
    repoNames = [];
  }

  return (
    <CustomAgentsManager
      installationId={String(activeInstallation.id)}
      isAdmin={isAdmin}
      repos={repoNames}
    />
  );
}
