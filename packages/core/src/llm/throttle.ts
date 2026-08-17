/**
 * #355 — provider-throttle classification.
 *
 * A rate-limited review is retriable work, not a failure: treating a
 * throttle as terminal is how 32 of 57 burst reviews were silently lost
 * (check FAILURE, no retry, no comment). Both runtimes use this one
 * classifier so "what counts as a throttle" can never drift between them.
 *
 * Shapes covered:
 *   - AWS SDK / Bedrock: `name` (or legacy `code`) 'ThrottlingException' /
 *     'TooManyRequestsException', or `$metadata.httpStatusCode` 429.
 *   - Anthropic direct / LiteLLM / OpenAI-compatible proxies: `status` 429.
 *   - Anything wrapping the above into a message: "too many requests",
 *     "rate limit", "throttl…". Bedrock's literal throttle message is
 *     "Too many requests, please wait before trying again."
 */
export function isThrottleError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;

  const name = typeof e.name === 'string' ? e.name : typeof e.code === 'string' ? e.code : '';
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException') return true;

  const metadata = e.$metadata as Record<string, unknown> | undefined;
  if (metadata?.httpStatusCode === 429) return true;
  if (e.status === 429 || e.statusCode === 429) return true;

  const message = typeof e.message === 'string' ? e.message : '';
  return /too many requests|rate limit|throttl/i.test(message);
}
