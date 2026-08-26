export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchUserInstallations, TokenExpiredError } from "@/lib/github-repos";
import { resolveActiveInstallation } from "@/lib/server-org";
import BillingClient from "./BillingClient";

interface BillingPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  // SaaS-only gate
  if (process.env.DEPLOYMENT_MODE !== "saas") {
    redirect("/dashboard");
  }

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

  const setupComplete = params.setup === "complete";

  return (
    <BillingClient
      installationId={String(activeInstallation.id)}
      accountLogin={activeInstallation.account.login}
      setupComplete={setupComplete}
    />
  );
}
