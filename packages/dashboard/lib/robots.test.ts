import { describe, expect, it } from "vitest";
import robots from "../app/robots";

/**
 * mergewatch/blog#5 — the blog is a separate Next app proxied at /blog with its
 * own sitemap. Crawlers read robots.txt from the host root only, and that root
 * is served by THIS app. If it does not list the blog's sitemap, the posts are
 * undiscoverable at their canonical host — published and invisible.
 */
describe("robots.txt", () => {
  const result = robots();
  const sitemaps = [result.sitemap].flat().filter(Boolean) as string[];

  it("lists both the product and the blog sitemaps", () => {
    expect(sitemaps).toContain("https://mergewatch.ai/sitemap.xml");
    expect(sitemaps).toContain("https://mergewatch.ai/blog/sitemap.xml");
  });

  it("does not block /blog", () => {
    // /blog is proxied through this app, so a disallow here would hide the
    // blog even though the blog's own robots.txt permits it.
    const disallowed = [result.rules]
      .flat()
      .flatMap((rule) => [rule?.disallow ?? []].flat());
    for (const path of disallowed) {
      expect(path.startsWith("/blog"), `${path} would hide the blog`).toBe(false);
    }
  });
});
