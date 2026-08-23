/**
 * #424 — these tests build real symlinks on a real filesystem on purpose.
 *
 * The vulnerability is invisible to lexical reasoning: every escaping path
 * here passes every string check, and only the filesystem reveals where it
 * lands. A mocked fs would assert the bug away.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  sanitizeRelativePath,
  isWithinRoot,
  resolveWithinRoot,
  GIT_HARDENING_ARGS,
  GIT_CLONE_SAFETY_ARGS,
} from './safe-path.js';

describe('sanitizeRelativePath', () => {
  it('accepts ordinary repo-relative paths', () => {
    expect(sanitizeRelativePath('src/index.ts')).toBe('src/index.ts');
    expect(sanitizeRelativePath('  packages/core/src/a.ts  ')).toBe('packages/core/src/a.ts');
  });

  it('collapses redundant separators and single dots', () => {
    expect(sanitizeRelativePath('src//a/./b.ts')).toBe('src/a/b.ts');
    expect(sanitizeRelativePath('./src/a.ts')).toBe('src/a.ts');
  });

  it('rejects absolute and drive-relative paths', () => {
    expect(sanitizeRelativePath('/etc/passwd')).toBeNull();
    expect(sanitizeRelativePath('C:/Windows/system.ini')).toBeNull();
  });

  it('rejects traversal segments', () => {
    expect(sanitizeRelativePath('../secret')).toBeNull();
    expect(sanitizeRelativePath('src/../../secret')).toBeNull();
    expect(sanitizeRelativePath('..')).toBeNull();
  });

  it('allows dots inside a filename — only a bare `..` segment is traversal', () => {
    // The predecessor rejected any path *containing* "..", which also refused
    // legitimate names. Segment-wise checking is both stricter and kinder.
    expect(sanitizeRelativePath('src/foo..bar.ts')).toBe('src/foo..bar.ts');
    expect(sanitizeRelativePath('...eslintrc')).toBe('...eslintrc');
  });

  it('rejects NUL bytes', () => {
    // Truncated at the syscall boundary: validated whole, opened as "a.ts".
    expect(sanitizeRelativePath('a.ts\0../../etc/passwd')).toBeNull();
  });

  it('rejects backslashes', () => {
    expect(sanitizeRelativePath('src\\a.ts')).toBeNull();
    expect(sanitizeRelativePath('..\\..\\etc')).toBeNull();
  });

  it('rejects empty and dot-only paths', () => {
    expect(sanitizeRelativePath('')).toBeNull();
    expect(sanitizeRelativePath('   ')).toBeNull();
    expect(sanitizeRelativePath('.')).toBeNull();
    expect(sanitizeRelativePath('./.')).toBeNull();
  });
});

describe('isWithinRoot', () => {
  it('treats the root itself as inside', () => {
    expect(isWithinRoot('/repo', '/repo')).toBe(true);
  });

  it('accepts descendants', () => {
    expect(isWithinRoot('/repo', `/repo${sep}src${sep}a.ts`)).toBe(true);
  });

  it('rejects a sibling that shares a prefix', () => {
    // The separator is the whole point: a bare startsWith says yes here.
    expect(isWithinRoot('/repo', '/repo-evil/secret')).toBe(false);
    expect(isWithinRoot('/repo', '/repository/secret')).toBe(false);
  });

  it('rejects ancestors', () => {
    expect(isWithinRoot('/repo/src', '/repo')).toBe(false);
  });

  it('handles a root with a trailing separator', () => {
    expect(isWithinRoot(`/repo${sep}`, `/repo${sep}a.ts`)).toBe(true);
    expect(isWithinRoot(`/repo${sep}`, '/repo-evil/a.ts')).toBe(false);
  });
});

describe('resolveWithinRoot — against a real filesystem', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'mw-safepath-'));
    root = join(base, 'worktree');
    outside = join(base, 'outside');

    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(join(root, 'src', 'real.ts'), 'export const a = 1;\n');
    await writeFile(join(outside, 'secret.txt'), 'do not read me\n');

    // The attack from the design doc: a symlink to an absolute path outside.
    await symlink('/etc', join(root, 'etc-link'), 'dir');
    // The relative variant — escapes without the path ever containing "..".
    await symlink('..', join(root, 'up'), 'dir');
    await symlink(outside, join(root, 'out-link'), 'dir');
    // A legitimate in-repo symlink, which must keep working.
    await symlink(join(root, 'src', 'real.ts'), join(root, 'alias.ts'), 'file');
    // A dangling symlink.
    await symlink(join(base, 'nope'), join(root, 'dangling.ts'), 'file');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('resolves an ordinary file inside the root', async () => {
    const got = await resolveWithinRoot(root, 'src/real.ts');
    expect(got).not.toBeNull();
    expect(got).toBe(join(await realpath(root), 'src', 'real.ts'));
  });

  it('BLOCKS a symlink to an absolute path outside the root', async () => {
    // The exact string from the design doc: no "..", not absolute, passes
    // every lexical check, and reads /etc/passwd if unguarded.
    expect(await resolveWithinRoot(root, 'etc-link/passwd')).toBeNull();
  });

  it('BLOCKS a symlink pointing at the parent directory', async () => {
    expect(await resolveWithinRoot(root, 'up/outside/secret.txt')).toBeNull();
  });

  it('BLOCKS a symlink to a sibling directory outside the root', async () => {
    expect(await resolveWithinRoot(root, 'out-link/secret.txt')).toBeNull();
  });

  it('BLOCKS the symlink directory itself, not merely paths under it', async () => {
    expect(await resolveWithinRoot(root, 'etc-link')).toBeNull();
  });

  it('allows a symlink that stays inside the root, resolved to its target', async () => {
    const got = await resolveWithinRoot(root, 'alias.ts');
    expect(got).toBe(join(await realpath(root), 'src', 'real.ts'));
  });

  it('returns null for a dangling symlink', async () => {
    expect(await resolveWithinRoot(root, 'dangling.ts')).toBeNull();
  });

  it('returns null for a file that does not exist', async () => {
    expect(await resolveWithinRoot(root, 'src/missing.ts')).toBeNull();
  });

  it('returns null for lexically invalid input without touching the fs', async () => {
    expect(await resolveWithinRoot(root, '../outside/secret.txt')).toBeNull();
    expect(await resolveWithinRoot(root, '/etc/passwd')).toBeNull();
    expect(await resolveWithinRoot(root, '')).toBeNull();
  });

  it('works when the ROOT ITSELF is reached through a symlink', async () => {
    // Not hypothetical: /tmp is a symlink to /private/tmp on macOS, so a root
    // that is not itself resolved never prefix-matches what realpath returns
    // and every legitimate read fails.
    const linkedRoot = join(base, 'root-via-link');
    await symlink(root, linkedRoot, 'dir');

    const got = await resolveWithinRoot(linkedRoot, 'src/real.ts');
    expect(got).not.toBeNull();
    expect(got).toBe(join(await realpath(root), 'src', 'real.ts'));

    // Containment still holds through the aliased root.
    expect(await resolveWithinRoot(linkedRoot, 'etc-link/passwd')).toBeNull();
  });

  it('rejects a sibling directory that shares the root name as a prefix', async () => {
    const evil = `${root}-evil`;
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, 'secret.txt'), 'nope\n');
    await symlink(evil, join(root, 'prefix-link'), 'dir');

    expect(await resolveWithinRoot(root, 'prefix-link/secret.txt')).toBeNull();
  });

  it('throws when the root itself does not exist — a caller bug, not repo input', async () => {
    await expect(resolveWithinRoot(join(base, 'no-such-root'), 'a.ts')).rejects.toThrow();
  });
});

describe('git hardening flags', () => {
  it('disables symlink materialisation, hooks, and ext:: remotes', () => {
    const joined = GIT_HARDENING_ARGS.join(' ');
    expect(joined).toContain('core.symlinks=false');
    expect(joined).toContain('core.hooksPath=/dev/null');
    expect(joined).toContain('protocol.ext.allow=never');
  });

  it('refuses submodules on clone', () => {
    expect(GIT_CLONE_SAFETY_ARGS).toContain('--no-recurse-submodules');
  });

  it('are frozen, so a caller cannot quietly drop a flag', () => {
    expect(Object.isFrozen(GIT_HARDENING_ARGS)).toBe(true);
    expect(Object.isFrozen(GIT_CLONE_SAFETY_ARGS)).toBe(true);
  });
});
