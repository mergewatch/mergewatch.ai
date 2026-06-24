import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing use of the hosted MergeWatch SaaS. The self-hosted distribution is licensed under AGPL v3.",
  alternates: { canonical: "/terms" },
};

export default function TermsOfServicePage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="April 13, 2026">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the
        hosted MergeWatch SaaS available at{" "}
        <a href="https://mergewatch.ai">mergewatch.ai</a> (the
        &ldquo;Service&rdquo;). The self-hosted MergeWatch distribution is
        licensed separately under the GNU Affero General Public License v3.0
        and is not governed by these Terms.
      </p>

      <h2>1. Acceptance</h2>
      <p>
        By installing the MergeWatch GitHub App or signing in to the hosted
        dashboard, you agree to these Terms. If you do not agree, do not
        install the App and do not use the Service.
      </p>

      <h2>2. The Service</h2>
      <p>
        MergeWatch reviews pull requests in repositories where you have
        installed the GitHub App, using large language models to produce
        comments and summaries. The Service is provided as-is and may be
        updated, suspended, or discontinued at any time. We do not guarantee
        that AI-generated reviews will catch all issues or be free of false
        positives. <strong>You remain responsible for the code you merge.</strong>
      </p>

      <h2>3. Your Responsibilities</h2>
      <ul>
        <li>You must have the authority to install MergeWatch on the repositories you connect.</li>
        <li>You must not use the Service to process code you are not permitted to share with third-party LLM providers (Amazon Bedrock).</li>
        <li>You must not attempt to reverse-engineer, disrupt, or abuse the Service, or use it to generate content that violates applicable law.</li>
        <li>You are responsible for keeping your GitHub account secure.</li>
      </ul>

      <h2>4. Billing and Plans</h2>
      <p>
        Paid plans are billed according to the pricing published at{" "}
        <a href="/pricing">mergewatch.ai/pricing</a>. You may upgrade,
        downgrade, or cancel at any time; changes take effect at the end of
        the current billing period. We do not offer refunds for partial
        periods except where required by law.
      </p>

      <h2>5. Open Source License</h2>
      <p>
        The MergeWatch source code is licensed under the GNU AGPL v3.0. Hosting
        your own modified version is permitted and encouraged under the terms
        of that license. See the{" "}
        <a
          href="https://github.com/mergewatch/mergewatch.ai/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
        >
          LICENSE file
        </a>{" "}
        for details.
      </p>

      <h2>6. Intellectual Property</h2>
      <p>
        You retain all rights to your code. MergeWatch does not claim any
        ownership of the repositories it reviews or the outputs it generates
        on your behalf. The MergeWatch name and logo are trademarks of the
        project maintainers.
      </p>

      <h2>7. Disclaimer of Warranties</h2>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
        AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED,
        INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS
        FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT
        THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF
        HARMFUL COMPONENTS.
      </p>

      <h2>8. Limitation of Liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL MERGEWATCH
        OR ITS MAINTAINERS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
        CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, DATA, OR
        GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE
        SERVICE. OUR TOTAL AGGREGATE LIABILITY SHALL NOT EXCEED THE GREATER
        OF (A) THE AMOUNTS YOU HAVE PAID US IN THE TWELVE MONTHS PRECEDING
        THE CLAIM OR (B) USD $100.
      </p>

      <h2>9. Termination</h2>
      <p>
        You may terminate your use of the Service at any time by uninstalling
        the GitHub App. We may suspend or terminate accounts that violate
        these Terms. Sections 6, 7, 8, and 10 survive termination.
      </p>

      <h2>10. Governing Law</h2>
      <p>
        These Terms are governed by and construed in accordance with the laws
        of the State of Delaware, United States, without regard to its
        conflict-of-laws principles. Any dispute arising out of or relating to
        these Terms or the Service shall be subject to the exclusive
        jurisdiction of the state and federal courts located in Delaware.
      </p>

      <h2>11. Changes</h2>
      <p>
        We may update these Terms from time to time. Material changes will be
        announced on{" "}
        <a
          href="https://github.com/mergewatch/mergewatch.ai/releases"
          target="_blank"
          rel="noopener noreferrer"
        >
          our GitHub releases page
        </a>
        . Continued use of the Service after a change constitutes acceptance
        of the updated Terms.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions: <a href="mailto:hello@mergewatch.ai">hello@mergewatch.ai</a>
        , or open a GitHub issue on the repository.
      </p>
    </LegalPage>
  );
}
