/**
 * FAQ content for /adversarial-defense.
 *
 * Kept in its own module so the page renders it and the layout can emit
 * matching FAQPage JSON-LD from one source — the same arrangement
 * `app/open-source/faqs.ts` uses. Editing an answer here updates both.
 */
export interface AdversarialFaq {
  question: string;
  answer: string;
}

export const adversarialFaqs: AdversarialFaq[] = [
  {
    question: "Is this a vulnerability scanner?",
    answer:
      "No. Scanners are genuinely useful and you should keep yours. What they mostly do is inspect one slice of a system at a time — this dependency, that endpoint, this configuration file. Adversarial Defense is aimed at the other problem: maintaining a model of how the pieces fit together, so it can reason about a chain that no single slice looks dangerous on its own.",
  },
  {
    question: "Does this replace penetration testing?",
    answer:
      "No, and we would not claim otherwise. A pen test is a skilled human adversary with judgment we cannot replicate. The gap we are trying to close is the months between tests, when the architecture keeps changing and nobody is asking adversarial questions of it.",
  },
  {
    question: "Will it run attacks against my production systems?",
    answer:
      "Only where you have explicitly authorized it, inside boundaries you set. The design assumes staging and test environments by default. Controlled testing is a pilot capability, not something that ships switched on, and it is gated by a policy layer rather than by our good intentions.",
  },
  {
    question: "Why start with pull request review?",
    answer:
      "Because that is where new risk enters. A pull request is the moment a system changes, and it comes with the context you need to judge the change — what it touches, what it depends on, what it used to do. Reviewing there also means the model accumulates an understanding of the codebase as a side effect of doing something useful today.",
  },
  {
    question: "What actually works today, and what am I joining a waitlist for?",
    answer:
      "PR review is live, in production, and free for qualifying open-source projects. Everything described on this page beyond that — stack modeling, attack-path generation, authorized testing — is what the waitlist is for. We would rather tell you that plainly than let a landing page imply otherwise.",
  },
  {
    question: "How does this relate to the open-source program?",
    answer:
      "The open-source program is the live product and, honestly, part of how the models learn. Maintainers get frontier-model review on code the ecosystem depends on; we get exposure to a far wider range of real architectures than a private-only customer base would ever show us. Adversarial Defense is where that understanding is heading.",
  },
];
