import Link from "next/link";
import { Wordmark } from "@/components/MergeWatchLogo";

export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <nav className="flex items-center justify-between px-6 py-4 md:px-12">
        <Link href="/">
          <Wordmark iconSize={20} />
        </Link>
        <div className="flex items-center gap-4 text-sm text-primer-muted">
          <Link href="/pricing" className="transition hover:text-fg-primary">
            Pricing
          </Link>
          <Link href="/signin" className="transition hover:text-fg-primary">
            Sign in
          </Link>
        </div>
      </nav>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 md:py-20">
        <h1 className="text-3xl font-extrabold tracking-tight md:text-5xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-primer-muted">
          Last updated: {lastUpdated}
        </p>
        <div className="prose prose-invert mt-8 max-w-none text-fg-primary [&_a]:text-primer-blue [&_a]:underline [&_h2]:mt-10 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_p]:my-4 [&_p]:leading-relaxed [&_p]:text-primer-muted [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:text-primer-muted">
          {children}
        </div>
      </main>

      <footer className="border-t border-border-default px-6 py-8 text-center text-xs text-primer-muted">
        <div className="flex flex-wrap justify-center gap-4">
          <Link href="/" className="hover:text-fg-primary">
            Home
          </Link>
          <Link href="/about" className="hover:text-fg-primary">
            About
          </Link>
          <Link href="/privacy" className="hover:text-fg-primary">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-fg-primary">
            Terms
          </Link>
          <a
            href="https://github.com/mergewatch/mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg-primary"
          >
            GitHub
          </a>
        </div>
        <p className="mt-4">
          Built by{" "}
          <a
            href="https://github.com/santthosh"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg-primary"
          >
            Santthosh
          </a>{" "}
          &middot; Open source under AGPL-3.0 &copy; {new Date().getFullYear()}{" "}
          mergewatch.ai
        </p>
      </footer>
    </div>
  );
}
