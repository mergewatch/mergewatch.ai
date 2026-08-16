/**
 * POST /api/waitlist — Adversarial Defense waitlist signup (#315).
 *
 * body: { name: string, email: string, website?: string }
 *   → { ok: true }  on success, and on silently-discarded bot submissions
 *
 * This is the only **unauthenticated write** endpoint in the dashboard, which
 * shapes most of what follows.
 *
 * Two ordering rules matter:
 *
 *   1. Store first, alert second. The Slack ping is best-effort — a webhook
 *      outage must never cost a lead. A market test is expensive per signup.
 *   2. Alert only on a genuinely new email. The conditional write tells us
 *      whether this was the first submission, so a refresh or a double-click
 *      does not ping twice.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TABLE = process.env.WAITLIST_TABLE ?? "mergewatch-waitlist";
const SLACK_WEBHOOK = process.env.SLACK_WAITLIST_WEBHOOK_URL;

/** RFC 5321 caps a domain-qualified address at 254 characters. */
const MAX_EMAIL = 254;
const MAX_NAME = 100;

/**
 * Deliberately permissive. The goal is to reject obvious junk, not to
 * adjudicate address validity — over-strict patterns reject real addresses
 * (plus-tags, new TLDs, unicode locals) and every rejection here is a lost
 * lead on a page whose entire purpose is measuring demand.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

let _client: import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient | null = null;

async function getClient() {
  if (_client) return _client;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const raw = new DynamoDBClient({
    region: process.env.APP_REGION ?? process.env.AWS_REGION ?? "us-east-1",
  });
  _client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return _client;
}

/**
 * Post to Slack. Never throws — the caller has already stored the signup and
 * must not fail the request because a webhook is down or unset.
 */
async function notifySlack(name: string, email: string): Promise<void> {
  if (!SLACK_WEBHOOK) {
    console.warn(
      "[waitlist] SLACK_WAITLIST_WEBHOOK_URL unset — signup stored but not announced",
    );
    return;
  }
  try {
    const res = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `*Adversarial Defense waitlist*\n${name} — ${email}`,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.error(`[waitlist] Slack responded ${res.status} for ${email}`);
    }
  } catch (err) {
    // Stored is what counts. Log loudly enough to notice a persistently
    // broken webhook, but never surface it to the visitor.
    console.error("[waitlist] Slack notify failed:", err);
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Honeypot. Real people never see this field; bots fill everything. Answer
  // 200 so a scraper cannot tell a discarded submission from an accepted one
  // and start probing for the tell.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!name || name.length > MAX_NAME) {
    return NextResponse.json({ error: "Please enter your name." }, { status: 400 });
  }
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  let isNew = true;

  try {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const client = await getClient();
    await client.send(
      new PutCommand({
        TableName: TABLE,
        Item: { email, name, createdAt: now, source: "adversarial-defense" },
        // First write wins, so `createdAt` records genuine first contact and a
        // repeat submission cannot re-trigger the alert below.
        ConditionExpression: "attribute_not_exists(email)",
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      // Already on the list. Same response as a new signup — telling a visitor
      // "you already signed up" is a worse experience and leaks list
      // membership to anyone who wants to probe it.
      isNew = false;
    } else {
      console.error("[waitlist] store failed:", err);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 },
      );
    }
  }

  if (isNew) await notifySlack(name, email);

  return NextResponse.json({ ok: true });
}
