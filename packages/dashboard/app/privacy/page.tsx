import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How MergeWatch handles your GitHub data, what we store, who we share it with, and how to delete it.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="April 29, 2026">
      <p>
        MergeWatch is an open-source GitHub App that reviews pull requests using
        AI. This Privacy Policy explains what data the hosted MergeWatch SaaS
        (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects when you install the App
        on your repositories, what we do with it, and how you can remove it.
        The self-hosted distribution (AGPL v3) does not send any data to us and
        is not covered by this policy.
      </p>

      <h2>1. Data We Read From GitHub</h2>
      <p>
        When you install the MergeWatch GitHub App, it is granted the
        permissions you approve during installation. At minimum, MergeWatch
        reads the following when a pull request is opened, synchronized, or
        reopened:
      </p>
      <ul>
        <li>The pull request diff (changed file paths, added and removed lines).</li>
        <li>Pull request metadata (title, description, base and head branch, commit SHAs, author login).</li>
        <li>Repository metadata (owner, repo name, default branch, visibility).</li>
        <li>
          The contents of <code>.mergewatch.yml</code> if one is present in the repository root.
        </li>
      </ul>
      <p>
        MergeWatch does <strong>not</strong> clone your repository, does not
        read files outside the PR diff, and does not access issues, wikis,
        actions, secrets, or deployments.
      </p>

      <h2>2. Data We Store</h2>
      <p>
        We store the minimum data required to operate the service. All data is
        held in AWS DynamoDB in the region where you install the service.
      </p>
      <ul>
        <li>
          <strong>Installation records:</strong> installation ID, repository
          full name, per-repo settings you choose in the dashboard.
        </li>
        <li>
          <strong>Review records:</strong> repository full name, PR number,
          commit SHA, review status, finding summaries, and the comment ID
          posted back to GitHub. Reviews are retained for <strong>90 days</strong> and
          then automatically deleted via DynamoDB TTL.
        </li>
        <li>
          <strong>Account and billing data:</strong> your GitHub user ID,
          email, and any billing metadata required by our payment processor if
          you are on a paid plan.
        </li>
      </ul>
      <p>
        We do <strong>not</strong> persist raw pull request diffs, raw file
        contents, or the full text of LLM responses. Diffs are held only in
        memory during a review and discarded when the review completes.
      </p>

      <h2>3. How Your Data Flows To LLM Providers</h2>
      <p>
        To generate a review, MergeWatch sends the pull request diff and
        metadata to a large language model provider. On the hosted SaaS that
        provider is <strong>Amazon Bedrock</strong>, using Anthropic Claude
        models hosted in AWS. No data is sent to any third-party LLM provider
        outside AWS.
      </p>
      <ul>
        <li>
          Amazon Bedrock does not use your inputs to train its models. See the{" "}
          <a
            href="https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            Bedrock data protection documentation
          </a>
          .
        </li>
        <li>Prompts are not retained by Bedrock beyond the duration of the inference call.</li>
        <li>
          If you self-host MergeWatch, you choose your own LLM provider via the{" "}
          <code>LLM_PROVIDER</code> environment variable; data flows only to
          the provider you configure.
        </li>
      </ul>

      <h2>4. Sub-Processors</h2>
      <ul>
        <li><strong>Amazon Web Services</strong> &mdash; compute, storage, and LLM inference (Bedrock).</li>
        <li><strong>GitHub, Inc.</strong> &mdash; authentication and the source of all code data we process.</li>
        <li>
          <strong>Google Analytics</strong> (mergewatch.ai marketing pages only)
          &mdash; aggregate page-view and traffic-source data for the public
          landing, pricing, sign-in, and policy pages. Google Analytics is{" "}
          <strong>not</strong> loaded on the authenticated dashboard or in the
          self-hosted distribution. You can opt out via your browser&rsquo;s
          Do Not Track setting, an ad blocker, or the official{" "}
          <a
            href="https://tools.google.com/dlpage/gaoptout"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Analytics opt-out browser add-on
          </a>
          .
        </li>
      </ul>

      <h2>5. Retention and Deletion</h2>
      <p>
        Review records are deleted automatically 90 days after creation.
        Installation records persist until you uninstall the GitHub App. When
        you uninstall, MergeWatch receives an{" "}
        <code>installation.deleted</code> webhook and removes all installation
        and settings records associated with your installation. To request
        deletion of any residual data, email the address in Section 9.
      </p>

      <h2>6. Security</h2>
      <p>
        All traffic is encrypted in transit via TLS. Secrets (GitHub App
        private key, webhook secret) are stored in AWS SSM Parameter Store with
        KMS encryption. The MergeWatch codebase is fully open source under AGPL
        v3 &mdash; you can audit exactly what runs on your code at{" "}
        <a
          href="https://github.com/mergewatch/mergewatch.ai"
          target="_blank"
          rel="noopener noreferrer"
        >
          github.com/mergewatch/mergewatch.ai
        </a>
        .
      </p>

      <h2>7. Your Rights</h2>
      <p>
        You can uninstall the GitHub App at any time from your GitHub settings,
        which revokes our access and triggers deletion of your installation
        data. You can request a copy of any data we hold about you, or request
        its deletion, by contacting us at the address in Section 9.
      </p>

      <h2>8. Changes To This Policy</h2>
      <p>
        Material changes to this Privacy Policy will be announced on{" "}
        <a
          href="https://github.com/mergewatch/mergewatch.ai/releases"
          target="_blank"
          rel="noopener noreferrer"
        >
          our GitHub releases page
        </a>{" "}
        and reflected in the &ldquo;Last updated&rdquo; date above.
      </p>

      <h2>9. Contact</h2>
      <p>
        Questions, data requests, or deletion requests:{" "}
        <a href="mailto:privacy@mergewatch.ai">privacy@mergewatch.ai</a>. You
        can also open a GitHub issue on the repository linked above.
      </p>
    </LegalPage>
  );
}
