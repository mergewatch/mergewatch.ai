export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — Pay for what you review",
  description:
    "No per-seat fees. First 5 reviews free. Self-host for free or use the managed SaaS with prepaid credits based on actual LLM cost.",
  alternates: { canonical: "/pricing" },
};

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const pricingJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "MergeWatch",
  url: "https://mergewatch.ai",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web, Linux, macOS",
  description:
    "AI-powered GitHub App that reviews pull requests with a multi-agent pipeline. Bring your own model, run in your cloud, or use the hosted SaaS.",
  offers: [
    {
      "@type": "Offer",
      name: "Self-Hosted",
      price: "0",
      priceCurrency: "USD",
      description:
        "Open source under AGPL v3. Deploy with Docker Compose, bring your own LLM provider.",
      url: "https://github.com/mergewatch/mergewatch.ai",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Managed SaaS",
      description:
        "Pay-as-you-go. First 5 pull request reviews free. Prepaid credits priced on actual LLM usage plus a small platform fee. No per-seat pricing.",
      url: "https://mergewatch.ai/pricing",
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        priceCurrency: "USD",
        price: "0",
        unitText: "Free tier: first 5 reviews per month",
      },
    },
  ],
  publisher: {
    "@type": "Organization",
    name: "MergeWatch",
    url: "https://mergewatch.ai",
  },
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (process.env.DEPLOYMENT_MODE !== "saas") {
    redirect("/signin");
  }

  return (
    <>
      {children}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(pricingJsonLd) }}
      />
    </>
  );
}
