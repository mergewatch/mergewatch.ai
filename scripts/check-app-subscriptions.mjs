#!/usr/bin/env node
/**
 * #601 — does the GitHub App actually receive the events the code dispatches on?
 *
 * `webhook.ts` has a `case` for every event it handles. GitHub delivers only
 * events the App is SUBSCRIBED to. Those two lists are maintained in different
 * places — one in the repo, one in a settings UI with no API to change it —
 * and nothing compares them.
 *
 * When they drift, the handler is simply never reached. No error, no log, no
 * failing test. #558 fixed the `check_suite` handler and shipped it inert
 * because the App was never subscribed; the "Re-run all checks" button stayed
 * dead in production for every user. #545 (a permission) and #602 (a handler
 * never reached) are the same shape.
 *
 * This compares the two lists. It CANNOT be satisfied by reading the repo
 * alone: one side comes from `GET /app`, authenticated as the App with a JWT
 * signed by its private key. A version that compared the dispatch cases to a
 * hardcoded list in this repo would pass today and catch nothing.
 *
 * Exit 0 = subscriptions cover every dispatched event.
 * Exit 1 = drift.
 * Exit 2 = could not check (missing credentials, API failure) — never silence.
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = resolve(dirname(process.argv[1]), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const STAGE = arg('--stage', 'prod');
// STAGE is interpolated into an SSM parameter path, so an unconstrained value
// (`../../something`) would read a parameter this script has no business
// reading. Today every caller passes a literal, which is exactly when a guard
// is cheap to add and nobody notices it is missing.
if (!/^[a-z0-9-]+$/.test(STAGE)) {
  console.error(`\n✗ COULD NOT CHECK — invalid stage name ${JSON.stringify(STAGE)}`);
  console.error('  Expected something like "prod" or "dev".');
  process.exit(2);
}

const cannotCheck = (msg) => {
  console.error(`\n✗ COULD NOT CHECK — ${msg}`);
  console.error('  This is not a pass. The subscriptions were not compared.');
  process.exit(2);
};

/* ── side A: what the code dispatches on ─────────────────────────────────── */
const WEBHOOK = resolve(REPO, 'packages/lambda/src/handlers/webhook.ts');
let src;
try { src = readFileSync(WEBHOOK, 'utf8'); } catch { cannotCheck(`cannot read ${WEBHOOK}`); }
// Strip comments first. A `case "check_suite":` written inside a comment —
// including the explanatory ones in webhook.ts about which events exist —
// would otherwise be counted as dispatched, and the check would report drift
// for an event nothing handles. A false drift report is as corrosive here as
// a missed one: both teach people to disregard the output.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');
const dispatched = [...new Set([...code.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]))].sort();
if (!dispatched.length) cannotCheck('no dispatch cases found — has the switch been refactored?');

/* ── side B: what GitHub will actually deliver ───────────────────────────── */
function ssm(name) {
  return execFileSync('aws', [
    'ssm', 'get-parameter', '--name', name, '--with-decryption',
    '--query', 'Parameter.Value', '--output', 'text',
  ], { encoding: 'utf8' }).trim();
}

let appId, pem;
try {
  appId = ssm(`/mergewatch/${STAGE}/github-app-id`);
  pem = ssm(`/mergewatch/${STAGE}/github-private-key`);
} catch (e) {
  cannotCheck(`could not read App credentials from SSM for stage "${STAGE}": ${e.message}`);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'RS256', typ: 'JWT' });
// `iss` is the App ID; GitHub documents it as a number. A string works today,
// which is the kind of thing that quietly stops working.
const body = b64({ iat: now - 60, exp: now + 540, iss: Number(appId) });
const jwt = `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem, 'base64url')}`;

let app;
try {
  const res = await fetch('https://api.github.com/app', {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) cannotCheck(`GET /app returned ${res.status}`);
  app = await res.json();
} catch (e) {
  cannotCheck(`GET /app failed: ${e.message}`);
}

const subscribed = [...(app.events ?? [])].sort();
if (!subscribed.length) cannotCheck('GET /app returned no events — refusing to report that as drift');

/* ── events delivered by a channel other than App subscriptions ──────────── */
// `marketplace_purchase` is configured on the Marketplace LISTING's own
// webhook, not in the App's event subscriptions, so it is correctly absent
// from GET /app. Its delivery was confirmed separately by an observed ping
// (#596). Flagging it would make this check permanently red for a non-defect,
// and a check that is always red is one people learn to ignore — which is the
// failure this exists to prevent.
//
// Anything added here needs a reason and evidence that the other channel
// works. It is an exemption, not a mute button.
const OTHER_CHANNEL = new Map([
  ['marketplace_purchase', 'Marketplace listing webhook (#596) — ping confirmed reaching prod'],
]);

/* ── compare ─────────────────────────────────────────────────────────────── */
// Only one direction is a defect. A subscribed event we do not dispatch is
// merely noise: the webhook answers 200 and ignores it. A DISPATCHED event we
// are not subscribed to is a feature that cannot run.
const missing = dispatched.filter((e) => !subscribed.includes(e) && !OTHER_CHANNEL.has(e));
const exempt = dispatched.filter((e) => !subscribed.includes(e) && OTHER_CHANNEL.has(e));
const extra = subscribed.filter((e) => !dispatched.includes(e));

console.log(`App: ${app.slug} (stage ${STAGE})`);
console.log(`  dispatched by webhook.ts : ${dispatched.join(', ')}`);
console.log(`  subscribed on the App    : ${subscribed.join(', ')}`);
if (extra.length) console.log(`  subscribed but unhandled : ${extra.join(', ')}  (harmless — answered 200 and ignored)`);
for (const e of exempt) console.log(`  delivered elsewhere      : ${e} — ${OTHER_CHANNEL.get(e)}`);

if (!missing.length) {
  console.log('\n✓ Every dispatched event is subscribed.');
  process.exit(0);
}

console.log(`\n✗ DRIFT — ${missing.length} dispatched event(s) the App will never receive:\n`);
for (const e of missing) console.log(`    ${e}`);
console.log('\n  The handlers for these exist and cannot run. No error will be logged,');
console.log('  because GitHub simply never delivers them.');
console.log(`\n  Fix in the App settings UI (there is no API): Settings → Developer settings`);
console.log(`  → GitHub Apps → ${app.slug} → Permissions & events → Subscribe to events.`);
process.exit(1);
