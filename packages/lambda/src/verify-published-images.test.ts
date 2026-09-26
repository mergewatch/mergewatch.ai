import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * #665 — `scripts/verify-published-images.sh`, exercised end to end.
 *
 * The other half of this fix is asserted on workflow structure
 * (docker-publish.test.ts), which is the right shape for "the gate calls the
 * verifier and decides from it". It cannot tell you whether the verifier itself
 * can fail, and "a check that cannot fail" is this repo's signature defect.
 *
 * So the real script runs here, against a fake registry that speaks enough of
 * the OCI distribution API to reproduce each failure. A fake rather than GHCR
 * because two of the cases are not inducible on demand against a real registry:
 * a manifest whose layer blob is absent, and a `latest` left pointing at the
 * previous release. The issue's acceptance criteria call for exactly that
 * substitution rather than a claim of coverage.
 *
 * The live positive and negative controls are separate, and were run by hand
 * against ghcr.io on the real v0.6.5 images (complete, published under a FAILED
 * job) and an absent tag. They are recorded in the PR, not here: a unit test
 * must not depend on the network or on a tag someone may delete.
 */
const SCRIPT = resolve(__dirname, '../../../scripts/verify-published-images.sh');

type FakeRepo = {
  /** tag or digest reference -> manifest digest */
  tags: Record<string, string>;
  /** manifest digest -> manifest document */
  manifests: Record<string, unknown>;
  /** layer blob digests the registry actually holds */
  blobs: Set<string>;
};

const digestOf = (doc: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(doc)).digest('hex');

/**
 * A complete multi-arch image: an index pointing at one platform manifest,
 * whose layers are all present. Mirrors what buildx actually pushes — the
 * verifier has to follow the index, because an index has no layers of its own.
 */
function completeImage(repo: FakeRepo, layerCount: number, tagsPointingHere: string[]) {
  const layers = Array.from({ length: layerCount }, (_, i) => ({
    digest: 'sha256:' + createHash('sha256').update(`layer-${i}`).digest('hex'),
    size: 100 + i,
  }));
  const platform = { schemaVersion: 2, config: { digest: 'sha256:cfg' }, layers };
  const platformDigest = digestOf(platform);
  const index = { schemaVersion: 2, manifests: [{ digest: platformDigest, platform: { architecture: 'amd64', os: 'linux' } }] };
  const indexDigest = digestOf(index);

  repo.manifests[platformDigest] = platform;
  repo.manifests[indexDigest] = index;
  repo.tags[platformDigest] = platformDigest;
  repo.tags[indexDigest] = indexDigest;
  for (const t of tagsPointingHere) repo.tags[t] = indexDigest;
  for (const l of layers) repo.blobs.add(l.digest);
  return { indexDigest, platformDigest, layers };
}

const emptyRepo = (): FakeRepo => ({ tags: {}, manifests: {}, blobs: new Set() });

let server: Server;
let base: string;
let registry: Record<string, FakeRepo> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'fake-pull-token' }));
      return;
    }
    const manifest = /^\/v2\/(.+)\/manifests\/([^/?]+)/.exec(url);
    if (manifest) {
      const repo = registry[decodeURIComponent(manifest[1])];
      const digest = repo?.tags[decodeURIComponent(manifest[2])];
      const doc = digest === undefined ? undefined : repo.manifests[digest];
      if (!doc) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.oci.image.index.v1+json',
        'docker-content-digest': digest,
      });
      res.end(JSON.stringify(doc));
      return;
    }
    const blob = /^\/v2\/(.+)\/blobs\/([^/?]+)/.exec(url);
    if (blob) {
      const repo = registry[decodeURIComponent(blob[1])];
      const present = repo?.blobs.has(decodeURIComponent(blob[2]));
      res.writeHead(present ? 200 : 404, { 'content-length': '0' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

type Result = { status: number; out: string; err: string };

/**
 * Async on purpose. `spawnSync` deadlocks here: the fake registry runs on this
 * process's event loop, and a synchronous child blocks it, so the script's first
 * request never gets an answer and the whole file hangs.
 */
function exec(args: string[], registryBase = base): Promise<Result> {
  return new Promise((done) => {
    execFile(
      'bash',
      [SCRIPT, ...args],
      { encoding: 'utf8', env: { ...process.env, REGISTRY_BASE: registryBase } },
      (err, stdout, stderr) => {
        const status = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
        done({ status, out: stdout, err: stderr });
      },
    );
  });
}

const run = (version: string, ...repos: string[]) => exec([version, ...repos]);

describe('#665 — the verifier exists and is wired to be run', () => {
  it('is present and executable, so the workflow can invoke it directly', () => {
    // The gate calls it as `scripts/verify-published-images.sh`, not `bash …`.
    // A committed file without the mode bit fails at release time only.
    expect(existsSync(SCRIPT)).toBe(true);
    const r = spawnSync('test', ['-x', SCRIPT]);
    expect(r.status, 'script is not executable — the release step would fail').toBe(0);
  });
});

describe('#665 — the positive case: complete images pass', () => {
  beforeAll(() => {
    registry = { 'mergewatch/mergewatch': emptyRepo(), 'mergewatch/mergewatch-dashboard': emptyRepo() };
    completeImage(registry['mergewatch/mergewatch'], 7, ['0.6.5', 'latest', '0.6']);
    completeImage(registry['mergewatch/mergewatch-dashboard'], 8, ['0.6.5', 'latest', '0.6']);
  });

  it('passes, resolving the index and every layer', async () => {
    // This is v0.6.5's real shape: 7 and 8 layers, nothing missing, matching
    // moving tags — while the publishing job reported failure.
    const r = await run('v0.6.5', 'mergewatch/mergewatch', 'mergewatch/mergewatch-dashboard');
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/layers: 7, missing: 0/);
    expect(r.out).toMatch(/layers: 8, missing: 0/);
    expect(r.out).toMatch(/all 2 image\(s\) verified complete at 0\.6\.5/);
  });

  it('accepts the git spelling of the version, which carries a `v`', async () => {
    // The registry tag is `0.6.5`; the gate passes `$VERSION`, which is
    // `v0.6.5`. Looking up `v0.6.5` would 404 on a perfectly good release.
    expect((await run('v0.6.5', 'mergewatch/mergewatch')).status).toBe(0);
    expect((await run('0.6.5', 'mergewatch/mergewatch')).status).toBe(0);
  });
});

describe('#665 — the negative cases: each check can actually fail', () => {
  it('fails when the version tag is absent, naming image and tag', async () => {
    registry = { 'mergewatch/mergewatch': emptyRepo() };
    completeImage(registry['mergewatch/mergewatch'], 3, ['0.6.4', 'latest', '0.6']);
    const r = await run('v0.6.5', 'mergewatch/mergewatch');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/mergewatch\/mergewatch:0\.6\.5 — tag is absent from the registry/);
  });

  it('fails when a layer blob is missing, naming the blob', async () => {
    // NOT inducible against GHCR, which is why the fake exists. It is also the
    // case the v0.6.5 error message *looked* like — `error writing layer blob:
    // not_found` — and the only way to tell the two apart is to go and look.
    registry = { 'mergewatch/mergewatch': emptyRepo() };
    const img = completeImage(registry['mergewatch/mergewatch'], 4, ['0.6.5', 'latest', '0.6']);
    const dropped = img.layers[2].digest;
    registry['mergewatch/mergewatch'].blobs.delete(dropped);

    const r = await run('v0.6.5', 'mergewatch/mergewatch');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(new RegExp(`layer blob ${dropped} is missing from the registry`));
  });

  it('fails when the manifest resolves but carries no layers', async () => {
    // A tag can point at something that is not an image. Presence alone would
    // report this as a complete publish.
    registry = { 'mergewatch/mergewatch': emptyRepo() };
    const repo = registry['mergewatch/mergewatch'];
    const doc = { schemaVersion: 2, config: { digest: 'sha256:cfg' }, layers: [] };
    const d = digestOf(doc);
    repo.manifests[d] = doc;
    for (const t of ['0.6.5', 'latest', '0.6']) repo.tags[t] = d;

    const r = await run('v0.6.5', 'mergewatch/mergewatch');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/manifest resolves but lists no layers/);
  });

  it('fails when an index cannot be followed to a platform manifest', async () => {
    registry = { 'mergewatch/mergewatch': emptyRepo() };
    const repo = registry['mergewatch/mergewatch'];
    const index = { schemaVersion: 2, manifests: [{ digest: 'sha256:vanished' }] };
    const d = digestOf(index);
    repo.manifests[d] = index;
    for (const t of ['0.6.5', 'latest', '0.6']) repo.tags[t] = d;

    const r = await run('v0.6.5', 'mergewatch/mergewatch');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/platform manifest sha256:vanished does not resolve/);
  });
});

describe('#665 — moving tags are asserted by digest, not by presence', () => {
  it('fails when `latest` still points at the previous release', async () => {
    // The failure a user actually hits, and currently invisible: `latest`
    // exists, so every presence check passes, and `docker pull …:latest`
    // quietly gives them the release before this one.
    registry = { 'mergewatch/mergewatch': emptyRepo() };
    const repo = registry['mergewatch/mergewatch'];
    const previous = completeImage(repo, 3, ['0.6.4', 'latest']);
    completeImage(repo, 4, ['0.6.5', '0.6']);

    const r = await run('v0.6.5', 'mergewatch/mergewatch');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/mergewatch\/mergewatch:latest — stale moving tag/);
    expect(r.err).toContain(previous.indexDigest);
  });

  it('fails when the MAJOR.MINOR tag disagrees with the version', async () => {
    registry = { 'mergewatch/mergewatch': emptyRepo() };
    const repo = registry['mergewatch/mergewatch'];
    completeImage(repo, 3, ['0.6']);
    completeImage(repo, 4, ['0.6.5', 'latest']);

    const r = await run('v0.6.5', 'mergewatch/mergewatch');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/mergewatch\/mergewatch:0\.6 — stale moving tag/);
  });

  it('fails when a moving tag was never published at all', async () => {
    registry = { 'mergewatch/mergewatch': emptyRepo() };
    completeImage(registry['mergewatch/mergewatch'], 3, ['0.6.5', '0.6']);
    const r = await run('v0.6.5', 'mergewatch/mergewatch');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/mergewatch\/mergewatch:latest — moving tag is absent/);
  });
});

describe('#665 — every image is checked, not just the first', () => {
  it('reports the second image even when the first is perfect', async () => {
    // fail-fast on the matrix is what cancelled the dashboard leg on v0.6.5.
    // A verifier that stopped at the first success would have the same blind
    // spot from the other side.
    registry = { 'mergewatch/mergewatch': emptyRepo(), 'mergewatch/mergewatch-dashboard': emptyRepo() };
    completeImage(registry['mergewatch/mergewatch'], 7, ['0.6.5', 'latest', '0.6']);
    // dashboard: published nothing

    const r = await run('v0.6.5', 'mergewatch/mergewatch', 'mergewatch/mergewatch-dashboard');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/mergewatch\/mergewatch-dashboard:0\.6\.5 — tag is absent/);
    // …and it still says what it found for the healthy one, so the reader can
    // tell "nothing published" from "one of two published".
    expect(r.out).toMatch(/layers: 7, missing: 0/);
  });

  it('counts the failures rather than reporting only the last one', async () => {
    registry = { 'mergewatch/mergewatch': emptyRepo(), 'mergewatch/mergewatch-dashboard': emptyRepo() };
    const r = await run('v0.6.5', 'mergewatch/mergewatch', 'mergewatch/mergewatch-dashboard');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/registry verification failed 2 check\(s\)/);
  });
});

describe('#665 — input handling', () => {
  it('rejects a malformed version instead of checking a nonsense tag', async () => {
    // Exit 2, not 1: bad input is not evidence about the registry, and the
    // release step must not read it as "the images are missing".
    const r = await run('v0.0.0-does-not-exist', 'mergewatch/mergewatch');
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/version must look like N\.N\.N/);
  });

  it('requires at least one image', async () => {
    // Verifying zero images would pass, having checked nothing.
    const r = await exec(['v0.6.5']);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/usage:/);
  });

  it('fails when the registry cannot be reached at all', async () => {
    // Silence from an unreachable registry must not read as success.
    const r = await exec(['v0.6.5', 'mergewatch/mergewatch'], 'http://127.0.0.1:1');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/could not obtain a pull token/);
  });
});
