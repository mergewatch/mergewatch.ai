import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import Link from "next/link";
import SignInButton from "./SignInButton";
import { Wordmark, LogoMark } from "@/components/MergeWatchLogo";

export default async function SignInPage() {
  const session = await getServerSession(authOptions);
  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Navbar */}
      <nav className="flex items-center justify-between px-6 py-4 md:px-12">
        <Link href="/">
          <Wordmark iconSize={20} />
        </Link>
      </nav>

      {/* Sign-in card */}
      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm">
          {/* Logo */}
          <div className="mb-8 flex justify-center">
            <LogoMark size={60} />
          </div>

          <h1 className="text-center text-2xl font-bold tracking-tight text-fg-primary">
            Sign in to mergewatch<span className="opacity-55">.ai</span>
          </h1>
          <p className="mt-2 text-center text-sm text-primer-muted">
            Frontier-model PR review — your model, your workflow, priced by PR.
          </p>

          {/* Card */}
          <div className="mt-8 rounded-xl border border-border-default bg-surface-card/60 p-6">
            <SignInButton />

            <p className="mt-6 text-center text-xs leading-relaxed text-primer-muted">
              We&apos;ll use your GitHub account to access repositories
              you&apos;ve installed the MergeWatch app on. No code is stored.
            </p>
          </div>

          <p className="mt-6 text-center text-xs text-primer-muted">
            <Link href="/" className="transition hover:text-fg-primary">
              &larr; Back to home
            </Link>
          </p>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border-default px-6 py-6 text-center text-xs text-primer-muted">
        &copy; {new Date().getFullYear()} mergewatch.ai &mdash; open source
        under AGPL-3.0
      </footer>
    </div>
  );
}
