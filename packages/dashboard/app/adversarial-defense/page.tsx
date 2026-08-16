"use client";

import { Wordmark } from "@/components/MergeWatchLogo";
import {
  ArrowRight,
  Boxes,
  GitPullRequest,
  Network,
  Radar,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { adversarialFaqs } from "./faqs";
import { WaitlistForm } from "./WaitlistForm";

/**
 * /adversarial-defense — market-test landing page.
 *
 * Deliberately has no site navigation. The only actions are the waitlist and
 * a jump to the explanation; every other link would be a way to leave without
 * answering the question this page exists to ask.
 *
 * Honesty constraint, carried from the brief: PR review is live today.
 * Everything else here is a waitlist or pilot capability and is labelled as
 * such wherever it appears. Present-tense copy about unbuilt capability would
 * poison the signal we are trying to collect — people would be signing up for
 * something we did not say clearly enough.
 */
export default function AdversarialDefensePage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Wordmark only — no nav. See the component doc comment. */}
      <header className="px-6 py-6 md:px-12">
        <Wordmark iconSize={20} />
      </header>

      <main className="flex-1">
        {/* ─── Hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col items-center px-6 pt-12 pb-16 text-center md:pt-20">
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-primer-green">
            AI-Native Continuous Adversarial Defense
          </p>
          <h1 className="mx-auto max-w-4xl text-3xl font-extrabold leading-tight tracking-tight md:text-5xl">
            Your attackers stopped scanning.{" "}
            <span className="text-primer-green">They started reasoning.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-primer-muted">
            An automated attack used to be fast and dumb. It is still fast. An
            agent can now infer your framework from an error message, guess how
            your auth probably works, form a theory about where that leaves you
            exposed, test it, and adjust — across many attempts at once.
            MergeWatch Adversarial Defense gives the defender the same kind of
            reasoning, from the inside, where the information is better.
          </p>

          <div className="mt-9 w-full">
            <WaitlistForm compact />
          </div>
          <a
            href="#how-it-works"
            className="mt-5 text-sm font-medium text-primer-muted underline-offset-4 transition hover:text-fg-primary hover:underline"
          >
            Or see how it works first
          </a>

          <p className="mt-5 max-w-xl text-xs leading-relaxed text-primer-muted">
            Pull request review is live today and free for qualifying
            open-source projects. Everything else on this page is what the
            waitlist is for.
          </p>
        </section>

        {/* ─── The asymmetry ────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              One vulnerability rarely gets anyone in.{" "}
              <span className="text-primer-green">A chain of five does.</span>
            </h2>
            <div className="mx-auto mt-6 max-w-2xl space-y-4 text-sm leading-relaxed text-primer-muted">
              <p>
                Most security tooling is organized around findings: this package
                has a CVE, this endpoint lacks a check, this bucket is readable.
                Each one gets a severity and a ticket. Individually, most are
                unremarkable, and teams reasonably deprioritize them.
              </p>
              <p>
                Real compromises are seldom one dramatic hole. They are an
                ordinary information leak, plus a permission that is slightly
                too broad, plus a dependency that behaves surprisingly under a
                specific input, plus a service that trusts a header it should
                not — assembled in an order nobody anticipated. Every link looked
                acceptable in isolation. Nothing in the toolchain was responsible
                for noticing the combination.
              </p>
              <p className="text-fg-primary">
                That assembly step is exactly what a reasoning attacker is good
                at, and it is the step no scanner performs.
              </p>
            </div>
          </div>
        </section>

        {/* ─── Defender's advantage ─────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              The attacker is guessing.{" "}
              <span className="text-primer-green">You are not.</span>
            </h2>
            <div className="mx-auto mt-6 max-w-2xl space-y-4 text-sm leading-relaxed text-primer-muted">
              <p>
                An outside attacker reconstructs your system from scraps —
                response timings, error strings, header quirks, whatever a
                changelog gave away. They are inferring the architecture.
              </p>
              <p>
                You already have it. The source. The dependency graph. The
                infrastructure definitions. The API surface. The authentication
                logic. Who can reach what. What changed last Tuesday and why.
                The defender has always held more information than the attacker
                and has rarely had a way to reason over all of it at once.
              </p>
            </div>

            <blockquote className="mx-auto mt-10 max-w-2xl border-l-2 border-primer-green pl-6">
              <p className="text-lg font-semibold leading-relaxed text-fg-primary md:text-xl">
                If something intelligent understood this entire system — not one
                file, all of it — what would it try first?
              </p>
            </blockquote>

            <p className="mx-auto mt-8 max-w-2xl text-sm leading-relaxed text-primer-muted">
              Adversarial Defense makes that a question your stack answers
              continuously, rather than one a consultant asks twice a year.
            </p>
          </div>
        </section>

        {/* ─── How it works ─────────────────────────────────────────────── */}
        <section
          id="how-it-works"
          className="scroll-mt-8 border-t border-border-default px-6 py-16 md:py-24"
        >
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              From a list of findings to a model of the system
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-sm leading-relaxed text-primer-muted">
              Six things happen continuously. The point of connecting them is
              that a finding only becomes interesting in the context of the
              others.
            </p>

            <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              <StepCard
                icon={<Boxes className="h-5 w-5" />}
                step="01"
                title="Map the stack"
                body="Code, dependencies, frameworks, APIs, infrastructure, data stores, third-party integrations — kept current rather than captured once in a diagram nobody has opened since."
              />
              <StepCard
                icon={<GitPullRequest className="h-5 w-5" />}
                step="02"
                title="Watch what changes"
                body="Pull requests, commits, dependency bumps, configuration edits, deployment topology. New risk is judged against the system it is landing in, not in isolation."
              />
              <StepCard
                icon={<Radar className="h-5 w-5" />}
                step="03"
                title="Form attack hypotheses"
                body="Ask how observable behavior, implementation detail, privilege and known weakness could be combined into something that actually works."
              />
              <StepCard
                icon={<Waypoints className="h-5 w-5" />}
                step="04"
                title="Rank by consequence"
                body="Likelihood, blast radius, reachability, privilege escalation, business impact. A ranked shortlist you can act on beats an exhaustive list you cannot."
              />
              <StepCard
                icon={<ShieldCheck className="h-5 w-5" />}
                step="05"
                title="Test only where authorized"
                body="Selected hypotheses validated in staging or explicitly approved environments, inside boundaries you define. Never a surprise."
                pilot
              />
              <StepCard
                icon={<Network className="h-5 w-5" />}
                step="06"
                title="Return it to the pull request"
                body="Findings surface where the change is being made, while it is still cheap to change — not in a report that arrives three sprints later."
              />
            </div>
          </div>
        </section>

        {/* ─── Why PR review first ──────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              Why this starts at the pull request
            </h2>
            <div className="mx-auto mt-6 max-w-2xl space-y-4 text-sm leading-relaxed text-primer-muted">
              <p>
                Not because review is the whole answer — because it is where new
                risk enters, and because it is the one place a system is
                explained while it changes. A pull request carries the intent,
                the diff, and the context in one artifact.
              </p>
              <p>
                Reviewing there has a second effect that matters more over time:
                the model accumulates an understanding of the codebase as a
                by-product of doing something useful today. Each subsequent
                capability needs that foundation.
              </p>
            </div>

            <div className="mt-10 rounded-xl border border-border-default bg-surface-card/60 p-6">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-fg-primary">
                Where this goes
              </p>
              <ol className="mt-5 space-y-4">
                <Phase n="1" title="Pull request review" live>
                  Security, correctness and reliability review on every change.
                  Free for qualifying open-source projects.
                </Phase>
                <Phase n="2" title="Repository understanding">
                  Persistent knowledge of the codebase, its architecture and its
                  history, instead of judging each pull request from scratch.
                </Phase>
                <Phase n="3" title="Stack-aware model">
                  Repository knowledge joined to infrastructure, APIs, cloud
                  configuration, data stores, authentication and external
                  services.
                </Phase>
                <Phase n="4" title="Attack-path generation">
                  Specialized agents propose plausible chains across the real
                  architecture, and rank them by what they would actually cost
                  you.
                </Phase>
                <Phase n="5" title="Controlled defensive testing">
                  Selected hypotheses validated where you have authorized it,
                  under policy and guardrails.
                </Phase>
                <Phase n="6" title="Continuous adversarial defense">
                  A standing internal model that re-reasons whenever the code,
                  the infrastructure, the dependencies or the behavior move.
                </Phase>
              </ol>
            </div>
          </div>
        </section>

        {/* ─── Agents ───────────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-4xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              Specialists, with something coordinating them
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-sm leading-relaxed text-primer-muted">
              Each agent understands one dimension properly. An orchestration
              layer decides which hypotheses are worth pursuing — the useful
              work is in choosing, not in scanning everything indiscriminately.
            </p>

            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              <AgentRow name="Stack Discovery" role="Builds and maintains the technology and dependency map" />
              <AgentRow name="Code Security" role="Reads code, commits and pull requests for exploitable behavior" />
              <AgentRow name="Dependency" role="Tracks vulnerable versions and dangerous combinations of them" />
              <AgentRow name="Infrastructure" role="Cloud configuration, permissions, exposure, secrets, topology" />
              <AgentRow name="API Attack" role="Models how exposed interfaces get abused or chained together" />
              <AgentRow name="Attack Chain" role="Assembles findings across components into multi-stage paths" />
              <AgentRow name="Adversarial Simulation" role="Asks what a capable external attacker would infer and try next" />
              <AgentRow name="Behavioral Testing" role="Validates selected hypotheses in authorized environments" pilot />
              <AgentRow name="Policy & Guardrail" role="Keeps every test inside the boundaries you set" pilot />
            </div>
          </div>
        </section>

        {/* ─── Open source ──────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              Open source is in the critical path
            </h2>
            <div className="mx-auto mt-6 max-w-2xl space-y-4 text-sm leading-relaxed text-primer-muted">
              <p>
                Core review is free for qualifying open-source projects, because
                a great deal of the world runs on libraries maintained by people
                with no security budget and not enough weekends.
              </p>
              <p>
                It is also, candidly, how the models learn. Open-source work
                exposes MergeWatch to a far wider range of real architectures,
                dependency habits and failure modes than any private customer
                base would. That breadth is what stack-aware defense needs.
                Saying so seems better than pretending it is purely altruism.
              </p>
            </div>
          </div>
        </section>

        {/* ─── FAQ ──────────────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 md:py-24">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold md:text-3xl">
              Reasonable questions
            </h2>
            <div className="mt-10 space-y-5">
              {adversarialFaqs.map((faq) => (
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

        {/* ─── Waitlist ─────────────────────────────────────────────────── */}
        <section className="border-t border-border-default px-6 py-16 text-center md:py-24">
          <h2 className="mx-auto max-w-2xl text-2xl font-bold md:text-3xl">
            Join the Adversarial Defense waitlist
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-primer-muted">
            We are looking for teams who already suspect that periodic scanning
            is not keeping pace: security-conscious startups, regulated
            engineering teams, platform and DevSecOps groups, and maintainers
            carrying infrastructure a lot of people depend on.
          </p>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-primer-muted">
            Early conversations shape what gets built first. If you have a
            specific fear about your own stack, that is the most useful thing
            you can bring.
          </p>
          <div className="mt-9">
            <WaitlistForm />
          </div>
        </section>
      </main>

      <footer className="border-t border-border-default px-6 py-10">
        <p className="text-center text-xs text-primer-muted">
          Open source under AGPL-3.0 &copy; {new Date().getFullYear()}{" "}
          mergewatch.ai
        </p>
      </footer>
    </div>
  );
}

/* ─── Inline sub-components ────────────────────────────────────────────── */

/** Badge marking a capability that is not generally available. */
function PilotBadge() {
  return (
    <span className="rounded-full border border-primer-blue/40 bg-primer-blue/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primer-blue">
      Pilot
    </span>
  );
}

function StepCard({
  icon,
  step,
  title,
  body,
  pilot = false,
}: {
  icon: React.ReactNode;
  step: string;
  title: string;
  body: string;
  pilot?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border-default bg-surface-card/60 p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-primer-green">{icon}</span>
        <span className="text-[11px] font-semibold tracking-widest text-primer-muted">
          {step}
        </span>
        {pilot && <span className="ml-auto"><PilotBadge /></span>}
      </div>
      <h3 className="text-base font-semibold text-fg-primary">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-primer-muted">{body}</p>
    </div>
  );
}

function Phase({
  n,
  title,
  live = false,
  children,
}: {
  n: string;
  title: string;
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          live
            ? "bg-primer-green text-black"
            : "border border-border-default text-primer-muted"
        }`}
      >
        {n}
      </span>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-fg-primary">{title}</h4>
          {live ? (
            <span className="rounded-full bg-primer-green/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primer-green">
              Live today
            </span>
          ) : (
            <PilotBadge />
          )}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-primer-muted">
          {children}
        </p>
      </div>
    </li>
  );
}

function AgentRow({
  name,
  role,
  pilot = false,
}: {
  name: string;
  role: string;
  pilot?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border-default bg-surface-card/40 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-fg-primary">{name}</p>
          {pilot && <PilotBadge />}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-primer-muted">{role}</p>
      </div>
    </div>
  );
}
