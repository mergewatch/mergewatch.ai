export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchUserInstallations, TokenExpiredError } from "@/lib/github-repos";
import InsightsClient from "@/components/InsightsClient";

interface AccuracyPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * /dashboard/accuracy — review-accuracy surface (formerly /dashboard/insights,
 * nav "FP Insights"). Answers "how often does MergeWatch get it right?" via the
 * false-positive funnel, dispute rates by agent, recurring noise themes, and a
 * per-repo dispute heatmap.
 *
 * Sister route to /dashboard/analytics (the value / ROI view). Selects the
 * active installation via `?org=<installationId>` (same convention as the rest
 * of /dashboard/*); redirects to /onboarding when the user has no installations
 * yet. The old /dashboard/insights path 308-redirects here (see next.config.js).
 */
export default async function AccuracyPage({ searchParams }: AccuracyPageProps) {
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
  const activeInstallation = orgParam
    ? installations.find((i) => String(i.id) === orgParam) ?? installations[0]
    : installations[0];

  const installationId = String(activeInstallation.id);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Accuracy</h1>
        <p className="mt-1 text-sm text-text-secondary">
          How often MergeWatch gets it right — false-positive feedback, dispute
          rates by agent, and recurring review noise (👍 / 👎 reactions,
          inline-thread resolves, <code className="px-1">/mergewatch reject</code>
          commands, and implicit silent drops). Updated hourly.
        </p>
      </header>
      <InsightsClient installationId={installationId} />
    </div>
  );
}
