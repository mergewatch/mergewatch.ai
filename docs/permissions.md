# What MergeWatch asks for, and why

MergeWatch is a code review tool. It reads your pull requests and writes review
comments. This page lists every permission the GitHub App requests, what each
one is actually used for, and — because we are asking for one more than we used
to — why.

If you would rather not take our word for it, all of this is enforceable by
reading the source: the entire GitHub client lives in
[`packages/core/src/github/client.ts`](../packages/core/src/github/client.ts).

## The change: Contents is now Read and write

**Previously:** `Contents: Read-only`
**Now:** `Contents: Read and write`

Existing installations will see a prompt from GitHub asking an owner to accept
this. Until someone accepts, your installation keeps the old permissions and
MergeWatch keeps working exactly as it does today — minus the one feature
described below.

### Why

MergeWatch resolves an inline review thread in two situations:

1. You reply `resolved` (or `/resolve`) in a finding's thread.
2. A finding is **withdrawn** on a later review — the code changed and the
   problem is gone — so the thread asserting it should not stay open.

Both call GitHub's `resolveReviewThread` GraphQL mutation. That mutation
requires **Contents: Read and write**, and `Pull requests: Read and write` is
not sufficient for it. This is unintuitive — the operation touches a comment
thread, not repository contents — and it is GitHub's requirement, not a design
choice of ours. It is documented by GitHub only in a community discussion:
<https://github.com/orgs/community/discussions/44650>

We found it the way you would expect: the feature silently did nothing in
production, and the API returned `Resource not accessible by integration`.

### What we do NOT do with it

`Contents: Read and write` is a broad permission. GitHub does not offer a
narrower one that covers thread resolution, so this is the smallest grant that
makes the feature work — not the smallest grant we would like to ask for.

MergeWatch does not, and will not without a further explicit change:

- push commits to your repository
- create, modify, or delete branches, files, or tags
- open or merge pull requests
- change repository settings

The write half of `Contents` is used for exactly one thing: resolving and
unresolving review threads that MergeWatch itself created.

### If you would rather not grant it

Decline the prompt. Everything else continues to work: reviews run, findings
post, inline comments appear, check runs pass and fail as before.

What you lose is thread tidying — a thread you have replied `resolved` to, or
whose finding no longer applies, stays open instead of collapsing. The
underlying signal is still recorded either way, so declining costs you
presentation, not correctness.

We would rather tell you that plainly than have you discover a permission you
did not expect.

## Every permission, and what uses it

| Permission | Level | Used for |
|---|---|---|
| **Pull requests** | Read and write | Reading the diff and PR metadata; posting the review summary, inline comments and review state (approve / request changes) |
| **Contents** | Read and write | **Read:** fetching file contents to ground and verify findings against the real code, and reading `.mergewatch.yml` and convention files. **Write:** resolving review threads (see above) |
| **Checks** | Read and write | Creating and updating the `MergeWatch Review` check run |
| **Issues** | Read and write | Pull request comments — GitHub delivers PR-level comments through the Issues API |
| **Metadata** | Read-only | Mandatory for every GitHub App |

### Events

`pull_request`, `issue_comment`, `pull_request_review_comment`, `installation`

`pull_request_review_comment` is what makes replying inside a finding thread
work. If you are configuring a self-hosted App and omit it, reviews will post
normally but threaded replies — including `resolved` and `/mergewatch reject` —
will be silently ignored.

## Self-hosted

If you self-host, you create and own the GitHub App, so you decide what it may
do. Grant `Contents: Read-only` and skip thread resolution if that suits your
policy better; nothing else changes.
