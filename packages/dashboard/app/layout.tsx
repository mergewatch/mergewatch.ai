import type { Metadata } from "next";
import ThemeProvider from "@/components/ThemeProvider";
import MaybeAnalytics from "@/components/MaybeAnalytics";
import "./globals.css";

const SITE_URL = "https://mergewatch.ai";
const SITE_NAME = "MergeWatch";
const SITE_DESCRIPTION =
  "AI-powered GitHub App that reviews pull requests with a multi-agent pipeline. Bring your own model, run in your cloud, or use the hosted SaaS.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "MergeWatch — AI-Powered PR Reviews",
    template: "%s — MergeWatch",
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/icon.svg",
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: "MergeWatch — AI-Powered PR Reviews",
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "MergeWatch — AI-Powered PR Reviews",
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
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

const jsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/icon.svg`,
    sameAs: ["https://github.com/mergewatch/mergewatch.ai"],
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
  },
  // SoftwareApplication is declared on /pricing/layout.tsx with real Offer
  // data. Do not duplicate it here — Google parsers flag two entities of
  // the same type on the same URL as a structured-data error.
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <ThemeProvider>{children}</ThemeProvider>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
        />
        <MaybeAnalytics />
      </body>
    </html>
  );
}
