import { describe, it, expect } from 'vitest';
import { isThrottleError } from './throttle.js';

describe('isThrottleError (#355)', () => {
  it('recognizes AWS SDK throttle names (Bedrock)', () => {
    expect(isThrottleError(Object.assign(new Error('Too many requests, please wait before trying again.'), { name: 'ThrottlingException' }))).toBe(true);
    expect(isThrottleError(Object.assign(new Error('x'), { name: 'TooManyRequestsException' }))).toBe(true);
    expect(isThrottleError({ code: 'ThrottlingException' })).toBe(true);
  });

  it('recognizes 429s in the shapes the providers throw', () => {
    expect(isThrottleError({ $metadata: { httpStatusCode: 429 } })).toBe(true); // AWS SDK v3
    expect(isThrottleError({ status: 429, message: 'rate_limit_error' })).toBe(true); // Anthropic direct
    expect(isThrottleError({ statusCode: 429 })).toBe(true); // OpenAI-compatible proxies
  });

  it('recognizes throttle-shaped messages from wrapping layers', () => {
    expect(isThrottleError(new Error('Too many requests, please wait before trying again.'))).toBe(true);
    expect(isThrottleError(new Error('Rate limit exceeded for model'))).toBe(true);
    expect(isThrottleError(new Error('Request was throttled'))).toBe(true);
  });

  it('does not classify ordinary failures as throttles', () => {
    expect(isThrottleError(new Error('AccessDeniedException: not authorized'))).toBe(false);
    expect(isThrottleError(Object.assign(new Error('boom'), { name: 'ValidationException' }))).toBe(false);
    expect(isThrottleError({ status: 500, message: 'Internal error' })).toBe(false);
    expect(isThrottleError('Too many requests')).toBe(false); // strings are not error objects
    expect(isThrottleError(null)).toBe(false);
    expect(isThrottleError(undefined)).toBe(false);
  });
});
