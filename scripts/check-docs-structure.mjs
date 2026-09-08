#!/usr/bin/env node
/**
 * Deterministic structural checks for docs-site/ and README.md (#576).
 *
 * This is the CHEAP half of the pre-release docs audit. It answers only
 * questions with a mechanical right answer — does this link resolve, is this
 * page reachable, is the frontmatter parseable — and deliberately says nothing
 * about whether the prose is TRUE. Factual drift is the agent audit's job
 * (scripts/audit-docs.mjs); conflating the two would let a green structural
 * run read as "the docs are correct", which is the exact illusion #576 exists
 * to remove.
 *
 * Runs per-PR because it costs nothing: a docs change that breaks the nav
 * should fail its own PR rather than surface at release time.
 *
 * Exit 0 = clean, 1 = findings, 2 = the checker itself could not run.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'docs-site';
const findings = [];
const add = (file, msg) => findings.push({ file, msg });

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync(ROOT)) {
  console.error(`✗ ${ROOT}/ not found — run from the repo root.`);
  process.exit(2);
}

const files = walk(ROOT);
const mdx = files.filter((f) => f.endsWith('.mdx'));
const slug = (f) => relative(ROOT, f).replace(/\.mdx$/, '');
const onDisk = new Set(mdx.map(slug));

/* ---- 1. frontmatter ---- */
for (const f of mdx) {
  const src = readFileSync(f, 'utf8');
  if (!src.startsWith('---\n')) {
    add(f, 'missing frontmatter block');
    continue;
  }
  const end = src.indexOf('\n---', 4);
  if (end === -1) {
    add(f, 'frontmatter block is not terminated');
    continue;
  }
  const fm = src.slice(4, end);
  for (const key of ['title', 'description']) {
    if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(fm)) add(f, `frontmatter missing "${key}"`);
  }
}

/* ---- 2. nav resolves both ways ---- */
const navPath = join(ROOT, 'docs.json');
if (!existsSync(navPath)) {
  console.error(`✗ ${navPath} not found`);
  process.exit(2);
}
const nav = new Set();
(function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'pages' && Array.isArray(v)) {
        for (const p of v) (typeof p === 'string' ? nav.add(p) : collect(p));
      } else collect(v);
    }
  }
})(JSON.parse(readFileSync(navPath, 'utf8')));

for (const p of [...nav].sort()) if (!onDisk.has(p)) add('docs.json', `nav lists "${p}" but no such page exists`);
for (const p of [...onDisk].sort()) if (!nav.has(p)) add(`${ROOT}/${p}.mdx`, 'page exists but is unreachable from the nav');

/* ---- 3. internal links and images resolve ---- */
const images = new Set(files.filter((f) => f.includes('/images/')).map((f) => relative(ROOT, f)));
const targets = [...mdx, 'README.md'].filter(existsSync);

for (const f of targets) {
  const src = readFileSync(f, 'utf8');

  for (const m of src.matchAll(/]\((\/[^)\s]*)\)/g)) {
    const [, href] = m;
    const path = href.split('#')[0].replace(/\/$/, '');
    if (!path) continue;
    if (path.startsWith('/images/')) {
      if (!images.has(path.slice(1))) add(f, `link to missing image "${href}"`);
    } else if (!onDisk.has(path.slice(1))) {
      add(f, `link to "${href}" resolves to no page`);
    }
  }

  for (const m of src.matchAll(/src="(\/images\/[^"]+)"/g)) {
    if (!images.has(m[1].slice(1))) add(f, `<img> references missing "${m[1]}"`);
  }
}

/* ---- 4. images nothing references ---- */
const referenced = new Set();
for (const f of targets) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\/images\/[A-Za-z0-9._-]+/g)) referenced.add(m[0].slice(1));
}
for (const img of [...images].sort()) {
  if (!referenced.has(img)) add(`${ROOT}/${img}`, 'image is not referenced by any page or the README');
}

/* ---- report ---- */
console.log(`Checked ${mdx.length} pages, ${images.size} images, and README.md.`);
if (!findings.length) {
  console.log('✓ Structural checks clean.');
  console.log('  (Structure only — this says nothing about whether the content is accurate.)');
  process.exit(0);
}
console.log(`\n✗ ${findings.length} structural finding(s):\n`);
for (const { file, msg } of findings) console.log(`  ${file}: ${msg}`);
process.exit(1);
