export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { adversarialFaqs } from "./faqs";

export const metadata: Metadata = {
  title: "MergeWatch Adversarial Defense — AI-native application security",
  description:
    "An internal security layer that models your code, dependencies, infrastructure, APIs and application behavior, then asks what an intelligent attacker would try. Starts at pull request review, where new risk enters. Join the waitlist.",
  alternates: { canonical: "/adversarial-defense" },
  openGraph: {
    title: "AI-native adversarial defense for modern software stacks",
    description:
      "Attackers now reason across whole stacks, not just scan them. MergeWatch gives defenders a stack-aware internal model that finds the plausible attack paths first.",
    url: "https://mergewatch.ai/adversarial-defense",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI-native adversarial defense for modern software stacks",
    description:
      "Attackers now reason across whole stacks, not just scan them. MergeWatch gives defenders a stack-aware internal model that finds the plausible attack paths first.",
  },
};

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const adversarialJsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: adversarialFaqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  },
];

/**
 * Layout for the Adversarial Defense market-test page.
 *
 * Mirrors app/open-source/layout.tsx: self-hosted builds never serve this page
 * (it is a hosted-product waitlist), and FAQ JSON-LD is emitted from the same
 * array the page renders so the two cannot drift.
 *
 * Deliberately does NOT render the shared site nav. This is a single-purpose
 * conversion page for market testing — every link that is not the waitlist is
 * a way to leave without answering the question we are asking.
 */
export default function AdversarialDefenseLayout({
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
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(adversarialJsonLd) }}
      />
    </>
  );
}
