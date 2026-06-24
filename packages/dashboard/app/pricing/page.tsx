"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/components/MergeWatchLogo";
import { Github, Server, Cloud, ChevronDown, Zap, CreditCard } from "lucide-react";

const INFRA_FEE = 0.005;
const MARGIN_PERCENT = 0.40;
const AVG_LLM_COST = 0.08; // average LLM cost per review
const FREE_REVIEWS = 5;

function platformFee(llmCost: number): number {
  return INFRA_FEE + llmCost * MARGIN_PERCENT;
}

function estimateCost(llmCost: number): number {
  return llmCost + platformFee(llmCost);
}

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* ─── Nav ───────────────────────────────────────────────────────── */}
      <nav className="flex items-center justify-between px-6 py-4 md:px-12">
        <Link href="/">
          <Wordmark iconSize={20} />
        </Link>
        <div className="flex items-center gap-4">
          <a
            href="https://docs.mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primer-muted transition hover:text-fg-primary"
          >
            Docs
          </a>
          <Link
            href="/pricing"
            className="text-sm font-medium text-fg-primary"
          >
            Pricing
          </Link>
          <a
            href="https://github.com/mergewatch/mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primer-muted transition hover:text-fg-primary"
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

      <main className="flex-1">
        {/* ─── Hero ──────────────────────────────────────────────────── */}
        <section className="px-6 pt-16 pb-12 text-center md:pt-24">
          <h1 className="mx-auto max-w-2xl text-3xl font-bold md:text-5xl">
            Pay for what you review.{" "}
            <span className="text-primer-green">
              Not for who reviews it.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-sm leading-relaxed text-primer-muted">
            No seats. No per-user fees. No contracts. You pay based on the
            actual LLM cost of each review&nbsp;&mdash; and your first{" "}
            <strong className="text-fg-primary">{FREE_REVIEWS} reviews</strong>{" "}
            are free, no credit card required.
          </p>
        </section>

        {/* ─── Self-Hosted Block ─────────────────────────────────────── */}
        <section className="px-6 pb-12">
          <div className="mx-auto max-w-3xl rounded-xl border border-border-default bg-surface-card/60 p-6">
            <div className="flex items-start gap-3">
              <Server className="mt-0.5 h-5 w-5 text-primer-green" />
              <div>
                <h2 className="text-lg font-semibold text-primer-green">
                  Self-Hosted &mdash; Always Free
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-primer-muted">
                  Deploy to your own infrastructure. You pay only your cloud
                  provider and LLM costs&nbsp;&mdash; MergeWatch never charges
                  you anything.
                </p>
                <p className="mt-3 text-sm text-fg-primary">
                  <strong>What you get:</strong> Full review pipeline, all
                  agents, dashboard, GitHub App, AGPL v3 source code.
                </p>
                <a
                  href="https://github.com/mergewatch/mergewatch.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center text-sm font-medium text-primer-green transition hover:brightness-110"
                >
                  View on GitHub &rarr;
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ─── SaaS Pricing ──────────────────────────────────────────── */}
        <section className="px-6 pb-16">
          <div className="mx-auto max-w-3xl rounded-xl border border-border-default bg-surface-card/60 p-6">
            <div className="flex items-start gap-3">
              <Cloud className="mt-0.5 h-5 w-5 text-primer-blue" />
              <div>
                <h2 className="text-lg font-semibold text-primer-blue">
                  Managed SaaS &mdash; How Pricing Works
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-primer-muted">
                  Hosted by MergeWatch. No infrastructure required.
                </p>
              </div>
            </div>

            {/* The formula */}
            <div className="mt-6 rounded-lg border border-border-default bg-surface-card/40 p-5">
              <h3 className="text-sm font-semibold text-fg-primary">
                The formula
              </h3>
              <p className="mt-2 text-sm text-primer-muted">
                Every review is billed based on its actual cost:
              </p>
              <div className="mt-3 rounded-md bg-surface-inset px-4 py-3 font-mono text-sm text-fg-primary">
                You pay = LLM cost + platform fee
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primer-yellow" />
                  <p className="text-sm text-primer-muted">
                    <strong className="text-fg-primary">LLM cost</strong>{" "}
                    &mdash; determined by the number of tokens processed. Larger
                    diffs consume more tokens and cost more. Smaller PRs cost
                    less.
                  </p>
                </div>
                <div className="flex items-start gap-3">
                  <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-primer-blue" />
                  <p className="text-sm text-primer-muted">
                    <strong className="text-fg-primary">Platform fee</strong>{" "}
                    &mdash; covers compute, storage, GitHub integration, the
                    multi-agent pipeline, dashboard, and ongoing development.
                    Scales with review size.
                  </p>
                </div>
              </div>
            </div>

            {/* Example reviews */}
            <div className="mt-6 overflow-x-auto">
              <ExampleTable />
            </div>

            <p className="mt-4 text-xs leading-relaxed text-primer-muted">
              Costs shown using Claude Sonnet on Amazon Bedrock at current
              pricing. Your actual cost depends on diff size, agent count, and
              prompt configuration.
            </p>
          </div>
        </section>

        {/* ─── What Affects Your Cost ──────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-xl font-bold md:text-2xl">
              What affects your cost?
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <CostFactor
                title="Diff size"
                description="The biggest factor. A 50-line fix costs a fraction of a 1,000-line feature PR."
              />
              <CostFactor
                title="Number of agents"
                description="MergeWatch runs multiple specialist agents per review. More agents = more thorough review = more tokens."
              />
              <CostFactor
                title="Agent prompt configuration"
                description="Agent prompts are customizable. More detailed instructions produce more thorough (and slightly more expensive) reviews."
              />
              <CostFactor
                title="Output length"
                description="Longer, more detailed review comments cost more in output tokens. Output tokens are 5x more expensive than input."
              />
            </div>
          </div>
        </section>

        {/* ─── Free Tier + Credits ─────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="rounded-xl border border-border-default bg-surface-card/60 p-6">
                <h3 className="text-base font-semibold text-fg-primary">
                  Free Tier
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-primer-muted">
                  Your first{" "}
                  <strong className="text-primer-green">
                    {FREE_REVIEWS} reviews
                  </strong>{" "}
                  are completely free&nbsp;&mdash; no credit card required. This
                  is a one-time evaluation period, not a monthly allowance.
                </p>
                <p className="mt-2 text-xs text-primer-muted">
                  Free reviews don&rsquo;t reset each month. They&rsquo;re
                  designed to let you see real value on real PRs before
                  committing anything.
                </p>
              </div>
              <div className="rounded-xl border border-border-default bg-surface-card/60 p-6">
                <h3 className="text-base font-semibold text-fg-primary">
                  Prepaid Credits
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-primer-muted">
                  Top up when you want, in amounts that make sense for your
                  team:
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[10, 25, 50, 100].map((amt) => (
                    <span
                      key={amt}
                      className="rounded-md border border-border-default bg-surface-inset px-3 py-1.5 text-sm font-medium text-fg-primary"
                    >
                      ${amt}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs text-primer-muted">
                  Optional <strong>auto-reload</strong> when your balance drops
                  below a threshold you set. Credits never expire. No
                  subscription. No minimum spend.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Calculator ────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16">
          <div className="mx-auto max-w-md text-center">
            <h2 className="text-xl font-bold md:text-2xl">
              What will I actually pay?
            </h2>
            <PrCalculator />
          </div>
        </section>

        {/* ─── Competitor Comparison ──────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-xl font-bold md:text-2xl">
              How does this compare?
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-center text-sm text-primer-muted">
              Per-seat tools charge the same whether your team merges 5 PRs or
              500 that month. MergeWatch charges only for reviews that actually
              happen.
            </p>

            <div className="mt-8 overflow-x-auto">
              <ComparisonTable />
            </div>

            <p className="mt-4 text-center text-xs italic text-primer-muted">
              Per-seat pricing based on typical ${PER_SEAT_PRICE}/dev/month plans.
              MergeWatch estimates use average review cost of ~${estimateCost(AVG_LLM_COST).toFixed(2)}/review
              based on Claude Sonnet pricing.
            </p>
          </div>
        </section>

        {/* ─── Token Math ─────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-xl font-bold md:text-2xl">
              A transparent look at the token math
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-center text-sm text-primer-muted">
              Using Claude Sonnet on Amazon Bedrock at current pricing ($3.00 /
              1M input tokens, $15.00 / 1M output tokens):
            </p>
            <div className="mt-6 space-y-3">
              <TokenFact
                fact="Each agent receives the full diff as input"
                detail="Input tokens scale with diff size"
              />
              <TokenFact
                fact="Output tokens are 5x more expensive than input"
                detail="Detailed review comments are the biggest cost driver"
              />
              <TokenFact
                fact="6 agents per review (default pipeline)"
                detail="Each agent call adds input + output tokens"
              />
            </div>
            <p className="mt-6 text-center text-xs leading-relaxed text-primer-muted">
              Rather than showing fixed prices that may not reflect your actual
              usage, we show the formula and let you estimate based on your
              team&rsquo;s real PR volume.
            </p>
          </div>
        </section>

        {/* ─── FAQ ───────────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-xl font-bold md:text-2xl">
              Frequently asked questions
            </h2>
            <div className="mt-8 space-y-2">
              <FaqItem question="What happens when I hit my 5 free reviews?">
                MergeWatch pauses reviews on your repository and posts a
                comment showing your team&rsquo;s pace and a link to add
                credits. Reviews resume the moment credits are available&nbsp;
                &mdash; no subscription required. The {FREE_REVIEWS} free
                reviews are a one-time, lifetime evaluation&nbsp;&mdash; once
                used, they don&rsquo;t refresh.
              </FaqItem>
              <FaqItem question="How do I know what I'll pay?">
                Use the calculator on this page to estimate based on your PR
                volume. Your actual cost depends on diff sizes and your agent
                configuration. Your billing dashboard shows your exact cost per
                review over time, so you always know what you&rsquo;re spending.
              </FaqItem>
              <FaqItem question="Is there a contract or minimum commitment?">
                No. MergeWatch is prepaid credits&nbsp;&mdash; add what you
                need, when you need it. No subscription, no minimum spend, no
                cancellation process. Unused credits stay in your account
                indefinitely.
              </FaqItem>
              <FaqItem question="Can I switch from SaaS to self-hosted?">
                Yes, at any time. Self-hosted is always free and uses the same
                codebase. You can export your config and redeploy whenever you
                like&nbsp;&mdash;{" "}
                <a
                  href="https://github.com/mergewatch/mergewatch.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primer-green underline"
                >
                  see the repo
                </a>
                .
              </FaqItem>
              <FaqItem question="Do you charge for skipped PRs?">
                No. Only completed reviews count. Draft PRs, excluded paths, and
                PRs over file limits are skipped and never billed.
              </FaqItem>
              <FaqItem question="What LLM does the SaaS version use?">
                Claude via Amazon Bedrock. We use the best available Sonnet
                model at the time of your review. Pricing reflects current
                Bedrock on-demand rates.
              </FaqItem>
              <FaqItem question="Why not just show a price-per-PR table?">
                Because it would be misleading. Your cost depends on diff size,
                agent count, and prompt configuration&nbsp;&mdash; all of which
                vary. We&rsquo;d rather give you the formula and real
                transparency than a number that may not reflect your actual
                usage.
              </FaqItem>
              <FaqItem question="Is the SaaS version AGPL-compliant?">
                Yes. MergeWatch is open source under AGPL v3. The SaaS version
                runs the same code available on GitHub.
              </FaqItem>
            </div>
          </div>
        </section>

        {/* ─── CTA ───────────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 text-center md:py-24">
          <h2 className="mx-auto max-w-xl text-2xl font-bold md:text-3xl">
            Start with your first {FREE_REVIEWS} reviews&nbsp;&mdash;{" "}
            <span className="text-primer-green">free.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-md text-sm text-primer-muted">
            No credit card. GitHub App install. Under 2 minutes.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href="/signin"
              className="inline-flex items-center rounded-lg bg-primer-green px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110"
            >
              Install the GitHub App
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
      </main>

      {/* ─── Footer ────────────────────────────────────────────────────── */}
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
          Open source under AGPL-3.0 &copy; {new Date().getFullYear()}{" "}
          mergewatch.ai
        </p>
      </footer>
    </div>
  );
}

/* ─── Inline sub-components ──────────────────────────────────────────────── */

function PrCalculator() {
  const [prs, setPrs] = useState("");

  const count = parseInt(prs, 10);
  const valid = !isNaN(count) && count >= 0;
  const billable = valid ? Math.max(0, count - FREE_REVIEWS) : 0;
  const cost = valid ? billable * estimateCost(AVG_LLM_COST) : null;

  return (
    <div className="mt-6">
      <label
        htmlFor="pr-count"
        className="block text-sm text-primer-muted"
      >
        How many PRs does your team merge per month?
      </label>
      <input
        id="pr-count"
        type="number"
        min={0}
        placeholder="e.g. 120"
        value={prs}
        onChange={(e) => setPrs(e.target.value)}
        className="mx-auto mt-3 block w-48 rounded-lg border border-border-default bg-surface-card px-4 py-2.5 text-center text-sm text-fg-primary placeholder:text-primer-muted focus:border-primer-green focus:outline-none focus:ring-1 focus:ring-primer-green"
      />
      {cost !== null && (
        <>
          <p className="mt-4 text-lg font-bold text-fg-primary">
            Estimated monthly cost:{" "}
            <span className="text-primer-green">
              ${cost.toFixed(2)}
            </span>
          </p>
          <p className="mt-1 text-xs text-primer-muted">
            {billable > 0
              ? `${FREE_REVIEWS} free + ${billable} billed at ~$${estimateCost(AVG_LLM_COST).toFixed(2)}/review avg`
              : `All ${count} reviews are within the free tier`}
          </p>
        </>
      )}
      <p className="mt-2 text-xs text-primer-muted">
        First {FREE_REVIEWS} reviews always free. Estimate uses average review
        cost&nbsp;&mdash; actual cost varies by diff size.
      </p>
    </div>
  );
}

function ExampleTable() {
  const examples = [
    { label: "Small (~100 lines)", llm: 0.03 },
    { label: "Medium (~400 lines)", llm: 0.08 },
    { label: "Large (~1,000 lines)", llm: 0.19 },
  ];

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border-default">
          <th className="pb-2 pr-4 font-medium text-primer-muted">
            Diff size
          </th>
          <th className="pb-2 pr-4 font-medium text-primer-muted">
            LLM cost
          </th>
          <th className="pb-2 pr-4 font-medium text-primer-muted">
            Platform fee
          </th>
          <th className="pb-2 font-medium text-primer-muted">You pay</th>
        </tr>
      </thead>
      <tbody className="text-fg-primary">
        {examples.map((ex, i) => (
          <tr
            key={ex.label}
            className={
              i < examples.length - 1
                ? "border-b border-border-subtle"
                : ""
            }
          >
            <td className="py-2.5 pr-4 text-primer-muted">{ex.label}</td>
            <td className="py-2.5 pr-4">${ex.llm.toFixed(3)}</td>
            <td className="py-2.5 pr-4">
              ${platformFee(ex.llm).toFixed(3)}
            </td>
            <td className="py-2.5 font-semibold text-primer-green">
              ${estimateCost(ex.llm).toFixed(3)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Per-seat competitor pricing: typical $24/dev/month plans
const PER_SEAT_PRICE = 24;

function competitorCost(devs: number): string {
  return `$${devs * PER_SEAT_PRICE}/mo`;
}

function monthlyEstimate(prs: number): number {
  return Math.max(0, prs - FREE_REVIEWS) * estimateCost(AVG_LLM_COST);
}

function ComparisonTable() {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border-default">
          <th className="pb-2 pr-4 font-medium text-primer-muted" />
          <th className="pb-2 pr-4 font-medium text-primer-muted">
            50 PRs/mo
          </th>
          <th className="pb-2 pr-4 font-medium text-primer-muted">
            200 PRs/mo
          </th>
          <th className="pb-2 font-medium text-primer-muted">
            500 PRs/mo
          </th>
        </tr>
      </thead>
      <tbody className="text-fg-primary">
        <tr className="border-b border-border-subtle">
          <td className="py-2.5 pr-4 text-primer-muted">
            Per-seat tool (5 devs)
          </td>
          <td className="py-2.5 pr-4">{competitorCost(5)}</td>
          <td className="py-2.5 pr-4">{competitorCost(5)}</td>
          <td className="py-2.5">{competitorCost(5)}</td>
        </tr>
        <tr className="border-b border-border-subtle">
          <td className="py-2.5 pr-4 text-primer-muted">
            Per-seat tool (20 devs)
          </td>
          <td className="py-2.5 pr-4">{competitorCost(20)}</td>
          <td className="py-2.5 pr-4">{competitorCost(20)}</td>
          <td className="py-2.5">{competitorCost(20)}</td>
        </tr>
        <tr>
          <td className="py-2.5 pr-4 font-medium text-primer-green">
            MergeWatch
          </td>
          <td className="py-2.5 pr-4 font-semibold text-primer-green">
            ~${monthlyEstimate(50).toFixed(0)}
          </td>
          <td className="py-2.5 pr-4 font-semibold text-primer-green">
            ~${monthlyEstimate(200).toFixed(0)}
          </td>
          <td className="py-2.5 font-semibold text-primer-green">
            ~${monthlyEstimate(500).toFixed(0)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function CostFactor({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border-default bg-surface-card/40 p-4">
      <h3 className="text-sm font-semibold text-fg-primary">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-primer-muted">
        {description}
      </p>
    </div>
  );
}

function TokenFact({ fact, detail }: { fact: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border-default bg-surface-card/40 px-4 py-3">
      <span className="mt-0.5 text-sm">&#x2022;</span>
      <div>
        <p className="text-sm font-medium text-fg-primary">{fact}</p>
        <p className="text-xs text-primer-muted">{detail}</p>
      </div>
    </div>
  );
}

function FaqItem({
  question,
  children,
}: {
  question: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border-default">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-fg-primary transition hover:bg-surface-card"
      >
        {question}
        <ChevronDown
          className={`ml-2 h-4 w-4 shrink-0 text-primer-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="border-t border-border-subtle px-4 py-3 text-sm leading-relaxed text-primer-muted">
          {children}
        </div>
      )}
    </div>
  );
}

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
