import { describe, it, expect, vi } from 'vitest';
import { runBounded, runBoundedAsync, SUBPROCESS_TEST_TIMEOUT_MS } from './subprocess';

vi.setConfig({ testTimeout: SUBPROCESS_TEST_TIMEOUT_MS });

/**
 * #660 — the helper must turn a hung child into a named failure, fast.
 *
 * The timeout cases are the point: a helper whose timeout silently did nothing
 * would pass every other test here and reintroduce the original flake.
 */
const HANG = ['-e', 'setTimeout(() => {}, 60000)'];

describe('runBounded', () => {
  it('kills a hung child and names the timeout, well before the child would exit', () => {
    const started = Date.now();
    expect(() => runBounded('node', HANG, { timeoutMs: 500 })).toThrow(/timed out after 500ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns a non-zero exit as a status, without throwing', () => {
    const r = runBounded('node', ['-e', 'process.exit(3)']);
    expect(r.status).toBe(3);
  });

  it('returns stdout and stderr', () => {
    const r = runBounded('node', ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
    expect(r).toEqual({ status: 0, stdout: 'out', stderr: 'err' });
  });

  it('names a child that cannot be started', () => {
    expect(() => runBounded('definitely-not-a-command-660', [])).toThrow(/failed to spawn/);
  });

  it('names a child killed by a signal', () => {
    expect(() => runBounded('node', ['-e', 'process.kill(process.pid, "SIGKILL")'])).toThrow(/killed by SIGKILL/);
  });

  it('passes cwd and env through', () => {
    const r = runBounded('node', ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.X660)'], {
      cwd: '/', env: { ...process.env, X660: 'set' },
    });
    expect(r.stdout).toBe('/|set');
  });
});

describe('runBoundedAsync', () => {
  it('kills a hung child and names the timeout', async () => {
    const started = Date.now();
    await expect(runBoundedAsync('node', HANG, { timeoutMs: 500 })).rejects.toThrow(/timed out after 500ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns a non-zero exit as a status, without rejecting', async () => {
    await expect(runBoundedAsync('node', ['-e', 'process.exit(3)'])).resolves.toMatchObject({ status: 3 });
  });

  it('names a child that cannot be started', async () => {
    await expect(runBoundedAsync('definitely-not-a-command-660', [])).rejects.toThrow(/failed to spawn/);
  });

  it('names a child killed by a signal, distinct from a timeout', async () => {
    await expect(
      runBoundedAsync('node', ['-e', 'process.kill(process.pid, "SIGKILL")']),
    ).rejects.toThrow(/killed by SIGKILL/);
  });
});
