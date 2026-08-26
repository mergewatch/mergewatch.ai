export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchUserInstallations, checkInstallationAdmin, TokenExpiredError } from "@/lib/github-repos";
import { resolveActiveInstallation } from "@/lib/server-org";
import SettingsForm from "@/components/SettingsForm";

interface SettingsPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
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

  const isAdmin = await checkInstallationAdmin(accessToken, activeInstallation);

  return (
    <SettingsForm
      installationId={String(activeInstallation.id)}
      isAdmin={isAdmin}
      accountLogin={activeInstallation.account.login}
      accountType={activeInstallation.account.type}
    />
  );
}
