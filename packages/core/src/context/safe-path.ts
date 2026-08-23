/**
 * #424 — path containment for tools that read a real checkout.
 *
 * The retrieval architecture materialises an attacker-controlled tree: the
 * corpus is a worktree of the PR head, and a PR may add anything a git tree
 * can express — including symlinks.
 *
 * `sanitizeFilePath` in `agentic-fetcher.ts` is sufficient for the path it
 * guards, because that path is resolved by the GitHub *API* against a repo
 * tree: a symlink there is a blob whose content is the link text, and the API
 * never traverses it. Once the same string is joined onto a directory on disk,
 * the guarantee evaporates. A PR containing
 *
 *     docs/notes -> /etc
 *
 * makes `read_file("docs/notes/passwd")` a read of `/etc/passwd`. That string
 * has no `..`, is not absolute, and passes every lexical check there is.
 * Lexical validation cannot see it; only the filesystem can.
 *
 * Two independent layers, either of which closes the hole:
 *
 * 1. `GIT_HARDENING_ARGS` sets `core.symlinks=false`, so checkout writes
 *    symlinks as *plain files containing the link text*. No symlink is ever
 *    created, so there is nothing to traverse.
 * 2. `resolveWithinRoot` resolves the path through the filesystem and verifies
 *    the result is still under the root, so a symlink that exists anyway —
 *    left by an earlier clone, a shared volume, an operator's own mirror —
 *    still cannot escape.
 *
 * Belt and braces on purpose: layer 1 depends on every clone site remembering
 * a flag, and this is not a mistake we want to be one forgotten flag away from.
 */

import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/**
 * `git` flags that make a checkout of untrusted content inert.
 *
 * Pass these to **every** git invocation that materialises a tree.
 *
 * - `core.symlinks=false` — checkout writes symlinks as small plain files
 *   holding the link text. This is git's own mechanism for filesystems without
 *   symlink support; here it is the primary containment layer.
 * - `core.hooksPath=/dev/null` — hooks are not transferred by clone, but a
 *   mirror that is re-fetched into, or any path where `.git` is reused, can
 *   carry them. Nothing in a reviewed repo should ever execute.
 * - `protocol.ext.allow=never` — `ext::` remote URLs run a shell command.
 *   Modern git already defaults to `never`; stating it means we do not inherit
 *   an operator's looser global config.
 */
export const GIT_HARDENING_ARGS: readonly string[] = Object.freeze([
  '-c', 'core.symlinks=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.ext.allow=never',
]);

/**
 * Clone flags that go with the hardening config.
 *
 * Submodules are opt-in for `git clone`, so this is belt-and-braces again —
 * but a submodule is a second attacker-controlled tree fetched from an
 * attacker-chosen URL, and CVE-2022-39253 is what that class of bug looks
 * like. Say no explicitly.
 */
export const GIT_CLONE_SAFETY_ARGS: readonly string[] = Object.freeze([
  '--no-recurse-submodules',
]);

/**
 * Lexical validation of a repo-relative path. No filesystem access.
 *
 * This is a *pre-filter*, not the containment check — it rejects the obvious
 * junk cheaply so `resolveWithinRoot` does not pay a syscall for it. Passing
 * this proves nothing about where the path lands on disk.
 *
 * Returns the normalised path, or `null` if it is not a usable relative path.
 */
export function sanitizeRelativePath(input: string): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // A NUL truncates the path at the syscall boundary: "a.ts\0../../etc" is
  // validated whole and opened as "a.ts".
  if (trimmed.includes('\0')) return null;

  // Backslash is a separator on Windows and a quoting character in enough
  // shells that treating it as an ordinary filename character is a trap.
  if (trimmed.includes('\\')) return null;

  if (trimmed.startsWith('/')) return null;      // POSIX absolute
  if (/^[a-zA-Z]:/.test(trimmed)) return null;   // Windows drive-relative

  const parts: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue; // collapse // and ./
    // Reject rather than collapse. `a/../b` is arithmetically fine, but a
    // model emitting it means something went wrong upstream, and silently
    // rewriting a path we were asked to read is worse than refusing it.
    if (segment === '..') return null;
    parts.push(segment);
  }
  if (parts.length === 0) return null;

  return parts.join('/');
}

/**
 * Whether `candidate` lies at or beneath `root`. Both must already be
 * absolute and fully resolved — this is pure string work.
 *
 * The separator matters: a bare `startsWith` says `/repo-evil` is inside
 * `/repo`.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/**
 * Resolve a repo-relative path against a worktree root, following symlinks,
 * and return it only if it is genuinely inside that root.
 *
 * **Callers must read the returned path, not the path they passed in.** The
 * return value is the fully resolved location; re-joining the original
 * relative path would reintroduce the traversal this function exists to stop.
 *
 * A symlink pointing *within* the worktree resolves and is allowed —
 * repositories use those legitimately.
 *
 * Returns `null` when the path is unusable: malformed, missing, unreadable, a
 * dangling symlink, or escaping the root. These are deliberately not
 * distinguished — the caller's response to all of them is the same, and a
 * caller that reports "outside the repo" differently from "not found" tells an
 * attacker which paths exist.
 *
 * Throws only if `root` itself cannot be resolved, which is a bug in the
 * caller rather than anything the reviewed repo controls.
 */
export async function resolveWithinRoot(
  root: string,
  relPath: string,
): Promise<string | null> {
  const rel = sanitizeRelativePath(relPath);
  if (rel === null) return null;

  // The root is resolved too, and this is load-bearing rather than tidiness:
  // /tmp is a symlink to /private/tmp on macOS, so a literal root of
  // /tmp/wt-1 would never prefix-match anything realpath returns.
  const realRoot = await realpath(resolve(root));

  const candidate = resolve(realRoot, rel);
  // Cheap reject before a second syscall. Only reachable via odd inputs, since
  // sanitizeRelativePath already removed `..`.
  if (!isWithinRoot(realRoot, candidate)) return null;

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return null;
  }

  return isWithinRoot(realRoot, resolved) ? resolved : null;
}
