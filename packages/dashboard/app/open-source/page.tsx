"use client";

import Link from "next/link";
import { Wordmark } from "@/components/MergeWatchLogo";
import {
  Github,
  ShieldCheck,
  Eye,
  HeartHandshake,
  MessageSquare,
  Check,
} from "lucide-react";
import { ossFaqs } from "./faqs";

/**
 * Application form for MergeWatch for Open Source.
 *
 * TODO(oss-program): replace the placeholder with the real Tally form URL
 * once it exists (decision Q6 — new Tally form, matching the design-partner
 * banner pattern). Until then the CTA points at this placeholder.
 */
const OSS_APPLY_URL = "https://tally.so/r/PLACEHOLDER";

const GITHUB_REPO = "mergewatch/mergewatch.ai";

/**
 * MergeWatch for Open Source — program landing page.
 *
 * Framed as ecosystem defense, not charity: maintainers face rising volumes
 * of plausible-but-risky AI-generated PRs and deserve frontier-model review
 * on their side too. Self-hosted builds never see this page (the layout
 * redirects to /signin when DEPLOYMENT_MODE !== "saas").
 */
export default function OpenSourcePage() {
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
          <Link
            href="/open-source"
            className="hidden text-sm font-medium text-fg-primary sm:inline"
          >
            For Open Source
          </Link>
          <a
            href={`https://github.com/${GITHUB_REPO}`}
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

      <main className="flex-1">
        {/* ─── Hero ────────────────────────────────────────────────────── */}
        <section className="flex flex-col items-center px-6 pt-16 pb-14 text-center md:pt-24">
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-primer-green">
            MergeWatch for Open Source
          </p>
          <h1 className="mx-auto max-w-3xl text-3xl font-extrabold leading-tight tracking-tight md:text-5xl">
            Free frontier-model review for{" "}
            <span className="text-primer-green">open-source maintainers.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-primer-muted">
            If you maintain a real open-source project, we&rsquo;ll give it free
            hosted MergeWatch access. AI-generated PRs are getting easier to
            produce and harder to inspect by hand&nbsp;&mdash; maintainers
            deserve frontier-model review on their side too. In exchange we ask
            for honest feedback and, if it helps, permission to list your
            project as an early open-source user.
          </p>
          <div className="mt-9 flex w-full max-w-sm flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <a
              href={OSS_APPLY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center rounded-lg bg-primer-green px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110 sm:w-auto"
            >
              Apply for free OSS access
              <ArrowIcon />
            </a>
            <a
              href={`https://github.com/${GITHUB_REPO}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center rounded-lg border border-border-default px-6 py-3 text-sm font-semibold text-fg-primary transition hover:bg-surface-card sm:w-auto"
            >
              Read the source code
              <Github className="ml-2 h-4 w-4" />
            </a>
          </div>
          <p className="mt-5 text-xs text-primer-muted">
            No contract. No seat pricing. No obligation to endorse it if
            it&rsquo;s not useful.
          </p>
        </section>

        {/* ─── Why we're giving this away ──────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              This is ecosystem defense,{" "}
              <span className="text-primer-green">not charity.</span>
            </h2>
            <div className="mx-auto mt-6 max-w-2xl space-y-4 text-sm leading-relaxed text-primer-muted">
              <p>
                Open-source maintainers are about to face more AI-generated code
                than anyone else, and much of it will be produced by extremely
                capable frontier models used carelessly, cheaply, or
                adversarially. Models like Claude Opus and GPT-class systems can
                generate plausible PRs at a speed maintainers cannot manually
                match.
              </p>
              <p>
                MergeWatch gives maintainers frontier-model review on their side
                too: an open, inspectable reviewer that helps protect
                open-source software from risky model-generated changes.
                Frontier models are powerful, and in the wrong workflow they can
                create convincing but dangerous code. MergeWatch helps
                maintainers spot risk, preserve review quality, and keep human
                maintainers in control&nbsp;&mdash; without handing the review
                workflow to a closed black-box vendor.
              </p>
            </div>
          </div>
        </section>

        {/* ─── The offer / the ask ─────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-border-default bg-surface-card/60 p-6">
              <div className="mb-3 text-primer-green">
                <HeartHandshake className="h-5 w-5" />
              </div>
              <h3 className="text-lg font-semibold text-primer-green">
                What you get
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm text-primer-muted">
                <ListItem>
                  Free access to the managed SaaS for your open-source project
                </ListItem>
                <ListItem>Help installing and configuring the GitHub App</ListItem>
                <ListItem>An optional, lightweight setup call</ListItem>
                <ListItem>
                  A direct line to shape review behavior through your feedback
                </ListItem>
              </ul>
            </div>
            <div className="rounded-xl border border-border-default bg-surface-card/60 p-6">
              <div className="mb-3 text-primer-blue">
                <MessageSquare className="h-5 w-5" />
              </div>
              <h3 className="text-lg font-semibold text-primer-blue">
                What we ask
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm text-primer-muted">
                <ListItem>Use MergeWatch on your project for real PRs</ListItem>
                <ListItem>Give direct, honest product feedback</ListItem>
                <ListItem>
                  If it&rsquo;s useful, permission to list your project/logo as
                  an early user&nbsp;&mdash; only after you&rsquo;re satisfied
                </ListItem>
                <ListItem>
                  Optional, later, and separately approved: a short quote or case
                  study
                </ListItem>
              </ul>
            </div>
          </div>
        </section>

        {/* ─── Eligibility / guardrails ────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              How the program works
            </h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              <GuardrailCard
                icon={<Eye className="h-4 w-4" />}
                title="Public repositories only"
                body="The program is for public, actively maintained open-source projects — not private code."
              />
              <GuardrailCard
                icon={<Check className="h-4 w-4" />}
                title="Manual approval, fair use"
                body="Each project is approved by hand with fair-use limits and no SLA. It stays lightweight on both sides."
              />
              <GuardrailCard
                icon={<ShieldCheck className="h-4 w-4" />}
                title="Logo permission is opt-in"
                body="We only list your project or logo after you've used MergeWatch and told us it helped. Never before."
              />
              <GuardrailCard
                icon={<HeartHandshake className="h-4 w-4" />}
                title="Stop anytime"
                body="No lock-in. Heavy usage may move to bring-your-own-key or sponsorship, but you can leave whenever you like."
              />
            </div>
          </div>
        </section>

        {/* ─── FAQ ─────────────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              Questions maintainers ask
            </h2>
            <div className="mt-10 space-y-6">
              {ossFaqs.map((faq) => (
                <div
                  key={faq.question}
                  className="rounded-xl border border-border-default bg-surface-card/60 p-6"
                >
                  <h3 className="text-base font-semibold text-fg-primary">
                    {faq.question}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-primer-muted">
                    {faq.answer}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─── CTA ─────────────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 text-center md:py-24">
          <h2 className="mx-auto max-w-2xl text-2xl font-bold md:text-3xl">
            Put frontier-model review on your{" "}
            <span className="text-primer-green">project&rsquo;s side.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-md text-sm text-primer-muted">
            Tell us about your project. Approval is manual and lightweight.
          </p>
          <div className="mt-8 flex justify-center">
            <a
              href={OSS_APPLY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-lg bg-primer-green px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110"
            >
              Apply for free OSS access
              <ArrowIcon />
            </a>
          </div>
        </section>
      </main>

      {/* ─── Footer ────────────────────────────────────────────────────── */}
      <footer className="border-t border-border-default px-6 py-12">
        <p className="text-center text-xs text-primer-muted">
          Open source under AGPL-3.0 &copy; {new Date().getFullYear()}{" "}
          mergewatch.ai &middot;{" "}
          <Link href="/" className="transition hover:text-fg-primary">
            Home
          </Link>{" "}
          &middot;{" "}
          <Link href="/pricing" className="transition hover:text-fg-primary">
            Pricing
          </Link>
        </p>
      </footer>
    </div>
  );
}

/* ─── Inline sub-components ──────────────────────────────────────────────── */

function ListItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primer-green" />
      <span>{children}</span>
    </li>
  );
}

function GuardrailCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-border-default bg-surface-card/40 p-4">
      <div className="flex items-center gap-2 text-primer-green">
        {icon}
        <h3 className="text-sm font-semibold text-fg-primary">{title}</h3>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-primer-muted">{body}</p>
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
