export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

interface AccuracyPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * /dashboard/accuracy — the review-accuracy surface is now a tab on the
 * Analytics page (/dashboard/analytics?tab=accuracy). This route is kept as a
 * permanent redirect so existing links/bookmarks (and the older
 * /dashboard/insights → /dashboard/accuracy hop in next.config.js) still
 * resolve. The active installation (`?org=`) is preserved across the redirect.
 */
export default async function AccuracyPage({ searchParams }: AccuracyPageProps) {
  const params = await searchParams;
  const org = typeof params.org === "string" ? params.org : undefined;
  const qs = new URLSearchParams({ tab: "accuracy" });
  if (org) qs.set("org", org);
  redirect(`/dashboard/analytics?${qs.toString()}`);
}
