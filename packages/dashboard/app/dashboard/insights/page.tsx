export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchUserInstallations, TokenExpiredError } from "@/lib/github-repos";
import InsightsClient from "@/components/InsightsClient";

interface InsightsPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * /dashboard/insights — FP-feedback dashboard surface (FB-F + FB-G).
 *
 * Sister route to `/dashboard/analytics`. The two have distinct intent:
 *   • /analytics — "how is MergeWatch performing?" (score trends, finding
 *     counts, severity breakdowns, durations).
 *   • /insights — "how accurate is MergeWatch from your reviewers'
 *     perspective?" (FP funnel, dispute rates, recurring themes).
 *
 * Selects the active installation via `?org=<installationId>` (same
 * convention as the rest of /dashboard/*). Redirects to /onboarding when
 * the user has no installations yet.
 */
export default async function InsightsPage({ searchParams }: InsightsPageProps) {
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
        <h1 className="text-xl font-semibold text-text-primary">FP-feedback insights</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Per-installation rolling-window aggregates of finding-level
          feedback signals (👍 / 👎 reactions, inline-thread resolves,
          <code className="px-1">/mergewatch reject</code> commands, and
          implicit silent drops). Updated nightly.
        </p>
      </header>
      <InsightsClient installationId={installationId} />
    </div>
  );
}
