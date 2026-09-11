import type { MetadataRoute } from "next";

const SITE_URL = "https://mergewatch.ai";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard", "/api/", "/signin", "/signout", "/onboarding"],
      },
      {
        // Opt out of Common Crawl, which feeds training corpora for many
        // LLMs. Dedicated AI search crawlers are allowed explicitly below.
        userAgent: "CCBot",
        disallow: "/",
      },
      {
        userAgent: [
          "GPTBot",
          "OAI-SearchBot",
          "ChatGPT-User",
          "ClaudeBot",
          "Claude-Web",
          "anthropic-ai",
          "PerplexityBot",
          "Perplexity-User",
          "Google-Extended",
          "Applebot-Extended",
        ],
        allow: "/",
        disallow: ["/dashboard", "/api/", "/signin", "/signout", "/onboarding"],
      },
    ],
    // The blog is a separate Next app proxied at /blog, so it has its own
    // sitemap that this one does not include. Crawlers read robots.txt from
    // the host root only, and that root is served by THIS app — so without
    // this line the blog's sitemap is undiscoverable at its canonical host,
    // and the posts are effectively unpublished (mergewatch/blog#5).
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/blog/sitemap.xml`],
    host: SITE_URL,
  };
}
