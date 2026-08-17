# Burst review resilience

**Status:** 🚧 In review
**Issue:** [#355](https://github.com/mergewatch/mergewatch.ai/issues/355)

A burst of PRs (the E2E suite opens ~57 in 15 minutes) used to silently lose reviews: Lambda fan-out scaled into a fixed Bedrock quota, throttles were treated as terminal failures, and nothing ever retried — 32/57 reviews died with a red check and no comment. Self-hosted had the same shape with a different limiter (unbounded fire-and-forget promises against the provider's rate limit, all lost on restart).

## Architecture

```
before                                   after
──────                                   ─────
SaaS: webhook ─(async invoke)→ agent      webhook ─→ SQS ─(MaximumConcurrency: 8)→ agent
      unbounded fan-out ❌                       paced backlog, redrive ×3 → DLQ ✅
Self: webhook ─(fire-and-forget)→ pipeline webhook ─→ review_jobs (Postgres) ─→ worker
      unbounded, lost on restart ❌              SKIP LOCKED claims, REVIEW_CONCURRENCY ✅
both: throttle → FAILURE check, no retry   throttle → status 'pending', check stays
      ❌                                        in_progress "rate limited", retried ✅
```

## Shared semantics (both runtimes)

- `isThrottleError()` in core classifies provider throttling (`ThrottlingException`, HTTP 429 in AWS/Anthropic/proxy shapes, throttle-shaped messages).
- On throttle: the review is parked back at `pending` (now claimable — `claimReview`'s retriable set includes it), the check run posts `in_progress` "Review queued — rate limited" instead of a terminal FAILURE, and the error is rethrown so the transport-level retry fires.
- Non-throttle errors keep the exact previous failure semantics.

## SaaS (SQS)

- `ReviewQueue` between webhook and review agent: event source with `ScalingConfig.MaximumConcurrency: 8`, `BatchSize: 1`, visibility timeout 360s (> the 300s function timeout; doubles as the throttle-retry delay).
- Redrive ×3 → `ReviewDLQ` (14-day retention) — exhaustion is visible, never silent.
- The webhook falls back to legacy direct async invoke when `REVIEW_QUEUE_URL` is unset (deploy-order safety); `payloadFromEvent()` accepts both invocation shapes.

## Self-hosted (Postgres — zero new infrastructure)

- `review_jobs` table consumed via `SELECT … FOR UPDATE SKIP LOCKED`: durable across `docker-compose pull`, multi-replica-safe, at-least-once (made safe by `claimReview` idempotency).
- In-process worker (`review-worker.ts`, same shape as the insights cron): claims up to **`REVIEW_CONCURRENCY`** (env, default 3) jobs per poll (**`2s`** interval), lock horizon 900s for crash recovery.
- Throttle → exponential backoff (60s × 2^attempt), up to 5 attempts, then `status = 'dead'` — the DLQ analogue, inspectable with `SELECT * FROM review_jobs WHERE status = 'dead'`.
- A processor-recorded terminal failure completes the job (delivery done); only throttles redeliver.
- Webhooks enqueue (one INSERT); when no queue is wired (tests, custom embeddings) dispatch falls back to the previous in-process call.

## Configuration

| Env (self-hosted) | Default | Meaning |
|---|---|---|
| `REVIEW_CONCURRENCY` | `3` | Reviews processed concurrently by the worker |

SaaS knobs (`MaximumConcurrency`, redrive, visibility) live in `infra/template.yaml`.

## Known limitations / future work

- All job modes share one queue — an inline reply queued behind a large review backlog waits its turn. Priority lanes are a possible refinement.
- A job that dies after max throttle attempts leaves its check run `in_progress` ("stuck", visible) rather than converting to a failure — same shape as an SQS DLQ arrival. Operator action: inspect the DLQ / `status='dead'` rows and re-drive.
- Bedrock quota sizing is tracked separately (#360), to be done after the concurrency cap defines the sustained rate.
