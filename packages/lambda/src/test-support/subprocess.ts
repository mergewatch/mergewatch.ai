import { spawnSync, execFile, type SpawnSyncOptions, type ExecFileOptions } from 'node:child_process';

/**
 * #660 — every subprocess a test spawns goes through here, with a timeout.
 *
 * A vitest timeout cannot stop a `spawnSync`: the event loop is blocked, so the
 * test "times out" only after the child exits on its own, and a hung child
 * hangs the file. app-subscriptions.test.ts flaked exactly this way (5055ms,
 * run 36211281871) because the script it spawns called real `aws`. Bounding the
 * child here turns a hang into a named failure instead of a red build that
 * says nothing about the code under test.
 *
 * `subprocess-hygiene.test.ts` fails if a test spawns without this helper, so
 * the next spawn cannot quietly reintroduce the unbounded kind.
 */

/** Per-child ceiling. Generous: the slowest child today finishes in ~1s. */
export const SUBPROCESS_TIMEOUT_MS = 10_000;

/**
 * Per-test ceiling for files that spawn. Well above SUBPROCESS_TIMEOUT_MS so a
 * test running a few children fails on the child's named timeout, not on
 * vitest's generic "Test timed out in 5000ms".
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;

export interface BoundedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface BoundedResult {
  status: number;
  stdout: string;
  stderr: string;
}

const describeCmd = (cmd: string, args: string[]) => [cmd, ...args].join(' ');

/**
 * Run a child synchronously. A non-zero exit is a result, not an error: tests
 * assert on exit codes. Throws only when the child produced no exit status at
 * all — it timed out, could not start, or was killed by a signal.
 */
export function runBounded(cmd: string, args: string[], opts: BoundedOptions = {}): BoundedResult {
  const timeout = opts.timeoutMs ?? SUBPROCESS_TIMEOUT_MS;
  const spawnOpts: SpawnSyncOptions = { cwd: opts.cwd, env: opts.env, timeout, encoding: 'utf8' };
  const r = spawnSync(cmd, args, spawnOpts);
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`${describeCmd(cmd, args)}: timed out after ${timeout}ms`);
    }
    throw new Error(`${describeCmd(cmd, args)}: failed to spawn: ${r.error.message}`);
  }
  if (r.status === null) {
    throw new Error(`${describeCmd(cmd, args)}: killed by ${r.signal}`);
  }
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

/**
 * Async twin, for children that talk to a server on this process's event loop
 * (verify-published-images.test.ts): `spawnSync` would block the loop the
 * server needs to answer, and deadlock.
 *
 * `execFile` reports a timeout differently from `spawnSync` — no ETIMEDOUT,
 * just `killed: true` — so that is checked before the generic signal case.
 */
export function runBoundedAsync(cmd: string, args: string[], opts: BoundedOptions = {}): Promise<BoundedResult> {
  const timeout = opts.timeoutMs ?? SUBPROCESS_TIMEOUT_MS;
  const execOpts: ExecFileOptions = { cwd: opts.cwd, env: opts.env, timeout, encoding: 'utf8' };
  return new Promise((resolve, reject) => {
    execFile(cmd, args, execOpts, (err, stdout, stderr) => {
      const out = { stdout: String(stdout), stderr: String(stderr) };
      if (!err) return resolve({ status: 0, ...out });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
      if (typeof e.code === 'number') return resolve({ status: e.code, ...out });
      // Also `killed: true`, but it is not a timeout.
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(new Error(`${describeCmd(cmd, args)}: output exceeded maxBuffer`));
      }
      if (e.killed) return reject(new Error(`${describeCmd(cmd, args)}: timed out after ${timeout}ms`));
      if (e.signal) return reject(new Error(`${describeCmd(cmd, args)}: killed by ${e.signal}`));
      reject(new Error(`${describeCmd(cmd, args)}: failed to spawn: ${e.message}`));
    });
  });
}
