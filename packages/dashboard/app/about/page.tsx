import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "About",
  description:
    "MergeWatch is an open-source multi-agent AI code reviewer built by Santthosh. Bring your own model, run in your cloud, or use the hosted SaaS.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <LegalPage title="About MergeWatch" lastUpdated="April 13, 2026">
      <p>
        MergeWatch is an open-source GitHub App that reviews pull requests
        using a multi-agent AI pipeline. It was built to answer a simple
        question: <em>why should the tool that reviews your code cost more as
        your team grows, run on infrastructure you can&rsquo;t see, and lock you
        into a model you didn&rsquo;t choose?</em>
      </p>

      <h2>What it does</h2>
      <p>
        Every pull request triggers a parallel pipeline of specialized agents
        &mdash; security, bugs, style, summary, architectural impact &mdash;
        plus any custom agents you define in <code>.mergewatch.yml</code>. The
        orchestrator deduplicates findings, ranks them by severity and
        confidence, and posts a single upsert-style comment on the PR. Most
        reviews complete in under 60 seconds.
      </p>

      <h2>Two ways to run it</h2>
      <ul>
        <li>
          <strong>Self-hosted (free, AGPL v3).</strong> One{" "}
          <code>docker-compose up</code>. Bring your own LLM provider &mdash;
          Anthropic direct, Amazon Bedrock, any OpenAI-compatible endpoint via
          LiteLLM (100+ providers), or Ollama for air-gapped environments.
          Your code never leaves your infrastructure.
        </li>
        <li>
          <strong>Managed SaaS.</strong> Install the GitHub App and go. Runs on
          Claude via Amazon Bedrock with IAM-native auth &mdash; no API keys to
          manage. Priced by pull request volume, not per seat, so hiring
          doesn&rsquo;t make your bill bigger.
        </li>
      </ul>

      <h2>Why open source</h2>
      <p>
        Code review tools read every line your team writes. Closing the source
        on that is the wrong trade-off. MergeWatch ships under AGPL v3 &mdash;
        the full pipeline, every agent prompt, every orchestrator, every
        comment template is in the repo. Your security team can audit it.
        Your engineers can fork it. If we disappear tomorrow, your workflow
        keeps running.
      </p>

      <h2>Who builds it</h2>
      <p>
        MergeWatch is built and maintained by{" "}
        <a
          href="https://github.com/santthosh"
          target="_blank"
          rel="noopener noreferrer"
        >
          Santthosh
        </a>
        , a software engineer who has spent the last decade-plus building and
        shipping developer tooling, web infrastructure, and SaaS products at
        small startups and large platform teams. MergeWatch is an opinionated
        response to a recurring frustration: every code review tool on the
        market either locks you into a closed model, prices per seat so that
        growing teams pay more for the same thing, or ships as a thin wrapper
        around a single LLM vendor.
      </p>
      <p>
        The project is developed in public. Every design decision, prompt
        change, and pipeline tweak lands as a regular commit on{" "}
        <a
          href="https://github.com/mergewatch/mergewatch.ai"
          target="_blank"
          rel="noopener noreferrer"
        >
          the GitHub repository
        </a>
        , and the project itself is dogfooded &mdash; MergeWatch reviews every
        pull request that goes into MergeWatch. Contributions of every size
        are welcome: pull requests, bug reports, provider adapters, custom
        agent ideas, documentation fixes, and security reports all land in the
        same issue tracker. If you want to discuss a larger change before
        opening a PR, start with a GitHub Discussion first.
      </p>
      <h2>Status and roadmap</h2>
      <p>
        MergeWatch is at version 1.0 as of April 2026 and is actively
        maintained. The public roadmap covers expanding the built-in agent
        library, first-class support for additional LLM providers, and
        deeper IDE integration so that reviewer comments can flow back into
        editors like Cursor, Zed, and VS Code without leaving the PR
        context. Follow the{" "}
        <a
          href="https://github.com/mergewatch/mergewatch.ai/releases"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub releases page
        </a>{" "}
        for changelog updates and new version announcements.
      </p>

      <h2>Get involved</h2>
      <ul>
        <li>
          <a
            href="https://github.com/mergewatch/mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
          >
            Star the repo on GitHub
          </a>
        </li>
        <li>
          <a
            href="https://docs.mergewatch.ai"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read the docs
          </a>
        </li>
        <li>
          <a
            href="https://github.com/mergewatch/mergewatch.ai/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open an issue or feature request
          </a>
        </li>
      </ul>
    </LegalPage>
  );
}
