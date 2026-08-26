export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { resolveActiveInstallation } from "@/lib/server-org";
import {
  fetchUserInstallations,
  checkInstallationAdmin,
  TokenExpiredError,
} from "@/lib/github-repos";
import RepositoriesClient from "./RepositoriesClient";

interface RepositoriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function RepositoriesPage({
  searchParams,
}: RepositoriesPageProps) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) redirect("/");

  const params = await searchParams;

  let installations;
  try {
    installations = await fetchUserInstallations(accessToken);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      redirect("/signout");
    }
    throw err;
  }

  if (installations.length === 0) redirect("/onboarding");

  const orgParam = typeof params.org === "string" ? params.org : undefined;
  const activeInstallation = await resolveActiveInstallation({
    installations,
    orgParam,
    githubUserId: (session as any).githubUserId as string | undefined,
  });

  const installationId = String(activeInstallation.id);
  const isAdmin = await checkInstallationAdmin(accessToken, activeInstallation);

  return (
    <RepositoriesClient
      isAdmin={isAdmin}
      installationId={installationId}
      githubAppSlug={process.env.GITHUB_APP_SLUG}
    />
  );
}
