/**
 * FAQ content for the MergeWatch for Open Source page. Shared between the
 * visible page (`page.tsx`) and the FAQPage structured data (`layout.tsx`)
 * so the two never drift. Answers are written as self-contained passages
 * for AI Overviews / ChatGPT-search extraction.
 */
export const ossFaqs: { question: string; answer: string }[] = [
  {
    question:
      "Who qualifies for free MergeWatch access as an open-source project?",
    answer:
      "MergeWatch for Open Source is for real, actively maintained open-source projects on public repositories. Approval is manual and lightweight: we look for a genuine project with ongoing pull-request activity, not a placeholder repo. There is no requirement to endorse MergeWatch before you have used it, and maintainers can stop at any time. Heavy usage may move to a bring-your-own-key or sponsorship arrangement so the program stays sustainable, but the starting offer is simply free hosted access in exchange for honest feedback.",
  },
  {
    question: "What does MergeWatch ask for in return?",
    answer:
      "Use MergeWatch on your project for real pull requests, and give honest product feedback. If MergeWatch turns out to be useful, we ask for permission to list your project or logo as an early open-source user — but only after you have used it and are satisfied, never before. An optional short quote or case study is a separate, later ask that always requires its own approval. Maintainers are not paid for promotion, and nothing about the program requires a public endorsement.",
  },
  {
    question: "Why is MergeWatch free for open-source maintainers?",
    answer:
      "Open-source maintainers are about to face more AI-generated pull requests than anyone else, and much of that code will be produced by capable frontier models used carelessly, cheaply, or adversarially. This is ecosystem defense, not charity: maintainers should not have to protect critical open-source infrastructure with weaker tools than the people flooding them with plausible but risky AI-generated PRs. MergeWatch puts frontier-model review on the maintainer's side — an open, inspectable reviewer that helps spot risk and preserve review quality while keeping human maintainers in control.",
  },
];
