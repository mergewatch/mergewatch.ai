export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ossFaqs } from "./faqs";

export const metadata: Metadata = {
  title:
    "MergeWatch for Open Source — Free frontier-model review for maintainers",
  description:
    "Free hosted MergeWatch access for qualifying open-source projects. Maintainers deserve frontier-model review on their side too, as AI-generated PRs get easier to produce and harder to inspect. In exchange we ask for feedback and, if it helps, permission to list your project.",
  alternates: { canonical: "/open-source" },
};

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const ossJsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Offer",
    name: "MergeWatch for Open Source",
    price: "0",
    priceCurrency: "USD",
    description:
      "Free hosted MergeWatch access for qualifying open-source projects, in exchange for feedback and optional permission to list the project.",
    url: "https://mergewatch.ai/open-source",
    availability: "https://schema.org/InStock",
    eligibleCustomerType: "https://schema.org/Enduser",
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: ossFaqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  },
];

export default function OpenSourceLayout({
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
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(ossJsonLd) }}
      />
    </>
  );
}
