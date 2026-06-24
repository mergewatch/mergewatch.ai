// Revalidate every 5 minutes so the CDN can cache the rendered HTML while
// still picking up deploy-time env changes within a reasonable window.
// DEPLOYMENT_MODE is inlined at build time via next.config.js, so the
// redirect branch is dead code in the SaaS build and this page renders
// as a static ISR asset.
export const revalidate = 300;

import { redirect } from "next/navigation";
import Link from "next/link";
import { Wordmark } from "@/components/MergeWatchLogo";
import {
  Github,
  Shield,
  Bug,
  Paintbrush,
  FileText,
  GitBranch,
  Server,
  Cloud,
  CheckCircle2,
  Star,
  Lock,
} from "lucide-react";

const GITHUB_REPO = "mergewatch/mergewatch.ai";

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Self-contained answer blocks optimized for AI Overviews, ChatGPT search,
 * and Perplexity passage extraction. Each answer opens with a direct
 * factual sentence and stays within the 90-170 word sweet spot. Rendered
 * both as visible page content and as FAQPage JSON-LD for AI systems.
 */
const faqs: { question: string; answer: string }[] = [
  {
    question: "What does MergeWatch review on a pull request?",
    answer:
      "MergeWatch runs five parallel specialist agents on every pull request: security (OWASP Top 10, SQL and command injection, exposed secrets, path traversal), bugs (null dereferences, race conditions, off-by-one errors, resource leaks), style (naming, dead code, missing types, unused imports), summary (PR intent, scope, and risk rating), and architectural impact (a Mermaid diagram of changed control flow). All agents execute in parallel via Promise.all, so total latency is bounded by the slowest agent, not the sum — most reviews complete in under 60 seconds end-to-end. You can define additional custom agents in .mergewatch.yml with just a name and a prompt, which makes it easy to add framework-specific checks or team conventions. Findings are deduplicated, ranked by severity and confidence, and posted as a single upsert-style comment on the pull request.",
  },
  {
    question: "How much does MergeWatch cost?",
    answer:
      "MergeWatch is priced by pull request volume, not per developer seat. A five-person team and a hundred-person team merging the same number of PRs pay the same amount, so hiring engineers does not make your bill bigger. The self-hosted distribution is free forever under the GNU AGPL v3 license — you bring your own LLM provider and pay that provider directly, with no markup from MergeWatch on top. The managed SaaS gives the first five reviews free every month, then uses prepaid credits based on actual LLM cost plus a small platform fee. There is no credit card required to start, no seat minimum, and no annual commitment — you can cancel at any time from the dashboard. See mergewatch.ai/pricing for the full interactive breakdown and per-PR cost calculator.",
  },
  {
    question: "Does MergeWatch support self-hosting?",
    answer:
      "Yes. MergeWatch ships as open-source software under the GNU AGPL v3 license, and the full source code — including every agent prompt, the orchestrator, and all comment templates — is available at github.com/mergewatch/mergewatch.ai. Self-hosting requires running docker-compose up, which starts an Express server backed by Postgres on any Docker-capable host. You supply your own GitHub App credentials, database URL, and LLM provider via environment variables, and the server auto-runs Drizzle migrations on startup. MergeWatch runs on AWS, GCP, Azure, bare metal, Fly.io, Railway, or any environment that can run a container. Your code never leaves your infrastructure, which makes the self-hosted distribution appropriate for regulated industries, air-gapped environments, and organizations with strict data residency or compliance requirements.",
  },
  {
    question: "Which LLM providers does MergeWatch support?",
    answer:
      "MergeWatch supports four LLM provider backends out of the box. Anthropic (direct Claude API) is the default for self-hosted installs and the fastest way to get started. Amazon Bedrock (IAM-authenticated Claude models) powers the managed SaaS and eliminates the need to manage API keys anywhere in your infrastructure. LiteLLM is an OpenAI-compatible proxy that gives access to 100+ providers including OpenAI, Google Gemini, Azure OpenAI, Groq, Together AI, Mistral, and Fireworks. Ollama supports local models like Llama 3 and Qwen for air-gapped or privacy-sensitive environments and is currently experimental. Self-hosted deployments select a provider via the LLM_PROVIDER environment variable. The ILLMProvider interface in @mergewatch/core is a single method, so contributing a new backend usually takes less than a hundred lines of code.",
  },
];

/**
 * Fetch live GitHub star count for social proof. ISR-cached for 5 minutes
 * via the fetch options, matching the page `revalidate` setting. Returns
 * null on any failure so the UI can fall back gracefully.
 */
async function getGithubStars(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      next: { revalidate: 300 },
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

/**
 * Landing page for mergewatch.ai — psychological copy rewrite.
 *
 * 9 sections: Nav, Hero, Social Proof, How It Works, Output Preview,
 * Three Pillars, Deployment Choice, Final CTA, Footer.
 *
 * Self-hosted deployments skip straight to /signin.
 */
export default async function LandingPage() {
  if (process.env.DEPLOYMENT_MODE !== "saas") {
    redirect("/signin");
  }
  const stars = await getGithubStars();
  return (
    <div className="flex min-h-screen flex-col">
      {/* ─── 0. Design-partner banner ──────────────────────────────────── */}
      <a
        href="https://tally.so/r/GxolrQ"
        target="_blank"
        rel="noopener noreferrer"
        className="group block w-full bg-primer-green text-black transition hover:brightness-110"
      >
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-center gap-1 px-6 py-2.5 text-center text-sm font-medium sm:flex-row sm:gap-3">
          <span>
            We&rsquo;re onboarding our first design partners &mdash; free
            through GA, direct line to the founder.
          </span>
          <span className="inline-flex items-center gap-1 font-semibold underline-offset-2 group-hover:underline">
            Join <ArrowIcon />
          </span>
        </div>
      </a>

      {/* ─── 1. Nav ────────────────────────────────────────────────────── */}
      <nav className="flex items-center justify-between px-6 py-4 md:px-12">
        <Wordmark iconSize={20} />
        <div className="flex items-center gap-4">
          <a
            href="https://docs.mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden text-sm text-primer-muted transition hover:text-fg-primary sm:inline"
          >
            Docs
          </a>
          <Link
            href="/pricing"
            className="hidden text-sm text-primer-muted transition hover:text-fg-primary sm:inline"
          >
            Pricing
          </Link>
          <a
            href="https://github.com/mergewatch/mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden text-primer-muted transition hover:text-fg-primary sm:inline"
            aria-label="GitHub repository"
          >
            <Github size={20} />
          </a>
          <Link
            href="/signin"
            className="inline-flex items-center rounded-lg bg-primer-green px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110"
          >
            Get started
            <ArrowIcon />
          </Link>
        </div>
      </nav>

      {/* ─── 2. Hero — Pain hook + identity ────────────────────────────── */}
      <section className="flex flex-col items-center px-6 pt-20 pb-16 text-center md:pt-28 md:pb-24">
        <h1 className="max-w-3xl text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
          The <span className="text-primer-purple">diff</span>{" "}
          <span className="text-primer-green">is too long.</span>{" "}
          <span className="text-primer-blue">It always is.</span>
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-primer-muted">
          MergeWatch runs specialized AI agents on every pull
          request&nbsp;&mdash; before your reviewer opens the diff. Security
          issues, logic bugs, style violations, and architectural risks surface
          as inline comments. Add your own custom agents for anything else.{" "}
          <strong className="text-fg-primary">
            Your reviewer makes the final call.
          </strong>
        </p>

        <div className="mt-10 flex w-full max-w-sm flex-col items-center gap-3 sm:w-auto sm:max-w-none sm:flex-row">
          <Link
            href="/signin"
            className="inline-flex w-full items-center justify-center rounded-lg bg-primer-green px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110 sm:w-auto"
          >
            Start reviewing in 2 minutes
            <ArrowIcon />
          </Link>
          <a
            href="https://github.com/mergewatch/mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center rounded-lg border border-border-default px-6 py-3 text-sm font-semibold text-fg-primary transition hover:bg-surface-card sm:w-auto"
          >
            Read the source code
            <Github className="ml-2 h-4 w-4" />
          </a>
        </div>

        <p className="mt-6 max-w-lg text-xs text-primer-muted">
          AGPL v3&nbsp;&mdash; the whole codebase, not just the parts
          we&rsquo;re comfortable showing you.
        </p>

        <p className="mt-3 text-[11px] uppercase tracking-widest text-primer-muted">
          v1.0 &middot; Updated April 2026 &middot; Actively maintained
        </p>
      </section>

      {/* ─── 3. Social Proof Bar ───────────────────────────────────────── */}
      <section className="border-y border-border-default px-6 py-12">
        <p className="text-center text-xs font-medium uppercase tracking-widest text-primer-muted">
          Runs on AWS &middot; GCP &middot; Azure &middot; Bare metal &middot;
          Fly.io &middot; Railway
        </p>

        <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-2">
          <a
            href={`https://github.com/${GITHUB_REPO}`}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-start gap-4 rounded-xl border border-border-default bg-surface-card/60 p-5 transition hover:border-primer-green hover:bg-surface-card"
          >
            <div className="rounded-lg bg-surface-inset p-2 text-primer-green">
              <Star className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-fg-primary">
                {stars !== null
                  ? `${stars.toLocaleString()} stars on GitHub`
                  : "Star MergeWatch on GitHub"}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-primer-muted">
                Real numbers, not testimonials. The full pipeline is public
                &mdash; agent prompts, orchestrator, comment templates. Audit
                what runs on your code before you install it.
              </p>
              <p className="mt-2 text-xs text-primer-green transition group-hover:underline">
                View the repo &rarr;
              </p>
            </div>
          </a>

          <div className="flex items-start gap-4 rounded-xl border border-border-default bg-surface-card/60 p-5">
            <div className="rounded-lg bg-surface-inset p-2 text-primer-purple">
              <Lock className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-fg-primary">
                AGPL v3 &middot; Self-host anywhere
              </p>
              <p className="mt-1 text-xs leading-relaxed text-primer-muted">
                Your code never has to leave your infrastructure.{" "}
                <code className="rounded bg-surface-inset px-1 py-0.5 text-[10px] text-fg-primary">
                  docker-compose up
                </code>{" "}
                and point it at Anthropic, OpenAI via LiteLLM, Ollama for
                air-gapped, or Amazon Bedrock with IAM auth. No API keys
                leave your network.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── 4. How It Works — Pipeline ────────────────────────────────── */}
      <section className="px-6 py-16 md:py-24">
        <h2 className="text-center text-2xl font-bold md:text-4xl">
          Built-in specialists. Custom agents. One review.{" "}
          <span className="text-primer-green">Seconds, not minutes.</span>
        </h2>

        <div className="mx-auto mt-12 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <AgentCard
            icon={<Shield className="h-5 w-5" />}
            name="Security"
            catches="SQL injection, XSS, secrets, OWASP Top 10"
            example="User input passed to exec() without sanitization"
            accent="text-primer-red"
          />
          <AgentCard
            icon={<Bug className="h-5 w-5" />}
            name="Bugs"
            catches="Null dereferences, off-by-ones, race conditions"
            example="Array index i+1 can exceed arr.length"
            accent="text-primer-orange"
          />
          <AgentCard
            icon={<Paintbrush className="h-5 w-5" />}
            name="Style"
            catches="Naming, dead code, missing types"
            example="Exported function has no return type annotation"
            accent="text-primer-purple"
          />
          <AgentCard
            icon={<FileText className="h-5 w-5" />}
            name="Summary"
            catches="PR intent, risk rating, scope"
            example="Adds rate limiting to /api/upload — medium risk"
            accent="text-primer-blue"
          />
          <AgentCard
            icon={<GitBranch className="h-5 w-5" />}
            name="Diagram"
            catches="Architecture impact, Mermaid flowchart"
            example="Control flow diagram of changed paths"
            accent="text-primer-green"
          />
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-primer-muted">
          All agents run in parallel&nbsp;&mdash; including your custom ones.
          Total latency is bounded by the slowest agent, not the sum. Most
          reviews complete in under 60 seconds. Define custom agents in{" "}
          <code className="rounded bg-surface-card px-1.5 py-0.5 text-xs text-fg-primary">
            .mergewatch.yml
          </code>{" "}
          with a name and a prompt.
        </p>
      </section>

      {/* ─── 4.5 Frequently Asked ──────────────────────────────────────── */}
      <section className="border-t border-border-default px-6 py-16 md:py-24">
        <h2 className="text-center text-2xl font-bold md:text-4xl">
          Frequently asked.{" "}
          <span className="text-primer-green">Directly answered.</span>
        </h2>

        <div className="mx-auto mt-12 max-w-3xl space-y-8">
          {faqs.map((faq) => (
            <div
              key={faq.question}
              className="rounded-xl border border-border-default bg-surface-card/60 p-6"
            >
              <h3 className="text-lg font-semibold text-fg-primary">
                {faq.question}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-primer-muted">
                {faq.answer}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── 5. What Reviewers See — Output Preview ────────────────────── */}
      <section className="border-t border-border-default px-6 py-16 md:py-24">
        <h2 className="text-center text-2xl font-bold md:text-4xl">
          Your reviewer opens the PR.{" "}
          <span className="text-primer-green">This is already there.</span>
        </h2>

        <div className="mx-auto mt-10 max-w-3xl overflow-hidden rounded-xl border border-border-default bg-surface-card">
          <div className="border-b border-border-default px-4 py-2 text-xs text-primer-muted">
            mergewatch[bot] &middot; reviewed just now
          </div>
          <div className="space-y-4 p-5 font-mono text-xs leading-relaxed text-fg-primary">
            {/* Pre-flight header */}
            <div>
              <span className="font-bold text-primer-green">
                Pre-flight check by MergeWatch &mdash; ready for your eyes
              </span>
            </div>

            {/* Already checked */}
            <div className="space-y-1 text-primer-muted">
              <p className="text-[10px] font-medium uppercase tracking-wide">
                Already checked for you:
              </p>
              <p>
                <CheckCircle2 className="mr-1 inline h-3 w-3 text-primer-green" />
                No secrets or tokens detected
              </p>
              <p>
                <CheckCircle2 className="mr-1 inline h-3 w-3 text-primer-green" />
                Lock files look clean
              </p>
              <p>
                <CheckCircle2 className="mr-1 inline h-3 w-3 text-primer-green" />
                847 lines scanned across 12 files, 40 known vulnerability
                patterns checked
              </p>
            </div>

            {/* Focus area */}
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-primer-muted">
                Focus your energy on:
              </p>
              <p className="mt-1 text-primer-orange">
                High risk &mdash; your attention here will matter most
              </p>
              <p className="mt-1 text-primer-muted">
                Adds authentication middleware to admin routes. One bypass path
                detected in routes/admin.ts &mdash; may be intentional.
              </p>
            </div>

            {/* Findings table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border-default text-primer-muted">
                    <th className="pb-1 pr-4 font-medium">Severity</th>
                    <th className="pb-1 pr-4 font-medium">Confidence</th>
                    <th className="pb-1 pr-4 font-medium">Location</th>
                    <th className="pb-1 font-medium">Finding</th>
                  </tr>
                </thead>
                <tbody className="text-fg-primary">
                  <tr className="border-b border-border-subtle">
                    <td className="py-1.5 pr-4 text-primer-red">critical</td>
                    <td className="py-1.5 pr-4 text-primer-orange">Likely</td>
                    <td className="py-1.5 pr-4 text-primer-muted">
                      src/api/handler.ts:42
                    </td>
                    <td className="py-1.5">
                      Unsanitized input passed to exec()
                    </td>
                  </tr>
                  <tr className="border-b border-border-subtle">
                    <td className="py-1.5 pr-4 text-primer-orange">high</td>
                    <td className="py-1.5 pr-4 text-primer-orange">Likely</td>
                    <td className="py-1.5 pr-4 text-primer-muted">
                      routes/admin.ts:18
                    </td>
                    <td className="py-1.5">
                      Auth middleware bypassed on /health
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4 text-primer-orange">warning</td>
                    <td className="py-1.5 pr-4 text-primer-muted">
                      Worth checking
                    </td>
                    <td className="py-1.5 pr-4 text-primer-muted">
                      lib/db.ts:91
                    </td>
                    <td className="py-1.5">
                      Missing null check on optional user
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Checklist */}
            <div className="space-y-1 text-primer-muted">
              <p className="text-[10px] font-medium uppercase tracking-wide">
                Before you approve, consider:
              </p>
              <p>
                &#9744; Is the auth bypass in routes/admin.ts:18 intentional?
              </p>
              <p>
                &#9744; Does the new retry logic handle network timeouts?
              </p>
            </div>

            {/* Deference footer */}
            <p className="border-t border-border-default pt-3 text-[10px] italic text-primer-muted">
              These are flags, not verdicts. You know this codebase.
            </p>
          </div>
        </div>

        <p className="mx-auto mt-6 max-w-xl text-center text-sm text-primer-muted">
          Posted as inline review comments + a top-level summary. Re-triggers
          automatically when new commits are pushed.
        </p>
      </section>

      {/* ─── 6. Three Pillars — Values ─────────────────────────────────── */}
      <section className="border-t border-border-default px-6 py-16 md:py-24">
        <h2 className="text-center text-2xl font-bold md:text-4xl">
          Built for teams that take code quality{" "}
          <span className="text-primer-green">seriously.</span>
        </h2>

        <div className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-3">
          <PillarCard
            title="Your team shouldn't cost more to review."
            accent="text-primer-green"
          >
            Most review tools charge per developer per month. Every
            engineer you hire makes your bill bigger&nbsp;&mdash; the tool
            that&rsquo;s supposed to help you scale penalizes growth. MergeWatch
            prices by PR volume, not headcount. A 5-person team and a
            100-person team merging the same number of PRs pay the same.
          </PillarCard>
          <PillarCard
            title="Read every line of code running on your PRs."
            accent="text-primer-purple"
          >
            AGPL v3. Not &ldquo;source available.&rdquo; Not a limited
            open-core wrapper around a closed engine. The full review
            pipeline&nbsp;&mdash; every agent prompt, every orchestrator, every
            comment template&nbsp;&mdash; is in the repo. Your security team can
            audit it. Your engineers can fork it.
          </PillarCard>
          <PillarCard
            title="Your code never has to leave your infrastructure."
            accent="text-primer-blue"
          >
            Self-host with a single{" "}
            <code className="rounded bg-surface-inset px-1 py-0.5 text-xs text-fg-primary">
              docker-compose up
            </code>
            . Use Anthropic, OpenAI via LiteLLM, Ollama for air-gapped
            environments, or Amazon Bedrock with IAM-native auth&nbsp;&mdash; no
            API keys to manage. GCP, AWS, Azure, bare metal. If you can run
            Docker, you can run MergeWatch.
          </PillarCard>
        </div>
      </section>

      {/* ─── 7. Deployment Choice — Two Paths ──────────────────────────── */}
      <section className="border-t border-border-default px-6 py-16 md:py-24">
        <h2 className="text-center text-2xl font-bold md:text-4xl">
          Choose your setup.{" "}
          <span className="text-primer-green">Change it anytime.</span>
        </h2>

        <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
          {/* Self-Hosted */}
          <div className="flex flex-col rounded-xl border border-border-default bg-surface-card/60 p-6">
            <div className="mb-3 text-primer-green">
              <Server className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-semibold text-primer-green">
              Self-Hosted &mdash; Free forever
            </h3>
            <ul className="mt-4 flex-1 space-y-2 text-sm text-primer-muted">
              <li>Deploy to any cloud in under 5 minutes</li>
              <li>Your LLM provider, your API keys, your bill</li>
              <li>Full code visibility &mdash; audit every line</li>
              <li>AGPL v3 &mdash; fork, customize, contribute back</li>
            </ul>
            <a
              href="https://github.com/mergewatch/mergewatch.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex w-full items-center justify-center rounded-lg border border-border-default px-6 py-3 text-sm font-semibold text-fg-primary transition hover:bg-surface-card"
            >
              View on GitHub
              <Github className="ml-2 h-4 w-4" />
            </a>
          </div>

          {/* Managed SaaS */}
          <div className="flex flex-col rounded-xl border border-border-default bg-surface-card/60 p-6">
            <div className="mb-3 text-primer-blue">
              <Cloud className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-semibold text-primer-blue">
              Managed SaaS
            </h3>
            <ul className="mt-4 flex-1 space-y-2 text-sm text-primer-muted">
              <li>GitHub App install &mdash; no infrastructure needed</li>
              <li>Runs on Claude via Amazon Bedrock</li>
              <li>Dashboard, review history, spend controls</li>
              <li>Upgrade, downgrade, or cancel anytime</li>
            </ul>
            <Link
              href="/signin"
              className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-primer-green px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110"
            >
              Get started
              <ArrowIcon />
            </Link>
            <Link
              href="/pricing"
              className="mt-2 text-center text-xs text-primer-muted transition hover:text-fg-primary"
            >
              See pricing &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* ─── 8. Final CTA — Loss Aversion Close ───────────────────────── */}
      <section className="border-t border-border-default px-6 py-16 text-center md:py-24">
        <h2 className="mx-auto max-w-3xl text-2xl font-bold md:text-4xl">
          The next bug that ships without this&nbsp;&mdash;{" "}
          <span className="text-primer-green">
            that&rsquo;s on the diff it passed through.
          </span>
        </h2>

        <p className="mx-auto mt-4 max-w-md text-sm text-primer-muted">
          Set up in 2 minutes. No credit card required.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/signin"
            className="inline-flex items-center rounded-lg bg-primer-green px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110"
          >
            Get started
            <ArrowIcon />
          </Link>
          <a
            href="https://github.com/mergewatch/mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-lg border border-border-default px-6 py-3 text-sm font-semibold text-fg-primary transition hover:bg-surface-card"
          >
            Self-host free
            <Github className="ml-2 h-4 w-4" />
          </a>
        </div>
      </section>

      {/* ─── 9. Footer ─────────────────────────────────────────────────── */}
      <footer className="border-t border-border-default px-6 py-12">
        <div className="mx-auto grid max-w-4xl gap-8 text-sm sm:grid-cols-3">
          <div>
            <h4 className="font-semibold text-fg-primary">Product</h4>
            <ul className="mt-3 space-y-2 text-primer-muted">
              <li>
                <a
                  href="https://docs.mergewatch.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition hover:text-fg-primary"
                >
                  Docs
                </a>
              </li>
              <li>
                <Link
                  href="/pricing"
                  className="transition hover:text-fg-primary"
                >
                  Pricing
                </Link>
              </li>
              <li>
                <a
                  href="https://docs.mergewatch.ai/self-hosting/overview"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition hover:text-fg-primary"
                >
                  Self-Hosting
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-fg-primary">Company</h4>
            <ul className="mt-3 space-y-2 text-primer-muted">
              <li>
                <Link
                  href="/about"
                  className="transition hover:text-fg-primary"
                >
                  About
                </Link>
              </li>
              <li>
                <a
                  href="https://github.com/mergewatch/mergewatch.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition hover:text-fg-primary"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/mergewatch/mergewatch.ai/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition hover:text-fg-primary"
                >
                  Changelog
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-fg-primary">Legal</h4>
            <ul className="mt-3 space-y-2 text-primer-muted">
              <li>
                <Link
                  href="/privacy"
                  className="transition hover:text-fg-primary"
                >
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link
                  href="/terms"
                  className="transition hover:text-fg-primary"
                >
                  Terms of Service
                </Link>
              </li>
              <li>
                <a
                  href="https://github.com/mergewatch/mergewatch.ai/blob/main/LICENSE"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition hover:text-fg-primary"
                >
                  AGPL v3 License
                </a>
              </li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-center text-xs text-primer-muted">
          Built by{" "}
          <a
            href="https://github.com/santthosh"
            target="_blank"
            rel="noopener noreferrer"
            className="transition hover:text-fg-primary"
          >
            Santthosh
          </a>{" "}
          &middot; Open source under AGPL-3.0 &copy; {new Date().getFullYear()}{" "}
          mergewatch.ai
        </p>
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faqs.map((faq) => ({
              "@type": "Question",
              name: faq.question,
              acceptedAnswer: {
                "@type": "Answer",
                text: faq.answer,
              },
            })),
          }),
        }}
      />
    </div>
  );
}

/* ─── Inline sub-components ──────────────────────────────────────────────── */

function AgentCard({
  icon,
  name,
  catches,
  example,
  accent,
}: {
  icon: React.ReactNode;
  name: string;
  catches: string;
  example: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-border-default bg-surface-card/60 p-4">
      <div className={`mb-2 ${accent}`}>{icon}</div>
      <h3 className={`text-sm font-semibold ${accent}`}>{name}</h3>
      <p className="mt-1 text-xs leading-relaxed text-primer-muted">
        {catches}
      </p>
      <p className="mt-2 rounded bg-surface-inset px-2 py-1 font-mono text-[10px] text-fg-primary">
        {example}
      </p>
    </div>
  );
}

function PillarCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border-default bg-surface-card/60 p-6">
      <h3 className={`text-base font-semibold ${accent}`}>{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-primer-muted">
        {children}
      </p>
    </div>
  );
}

/** Small right-arrow SVG used in CTA buttons. */
function ArrowIcon() {
  return (
    <svg
      className="ml-2 h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13 7l5 5m0 0l-5 5m5-5H6"
      />
    </svg>
  );
}
