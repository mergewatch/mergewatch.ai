"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

type Status = "idle" | "submitting" | "done" | "error";

/**
 * Waitlist capture for /adversarial-defense.
 *
 * Inline rather than a link to a hosted form: this is a market test, and every
 * redirect between reading the pitch and entering an address costs signups —
 * which is the exact quantity being measured.
 *
 * Two fields only. Each additional question trades conversion for detail, and
 * at this stage the question is "does anyone want this", not "who are they".
 * The richer qualification (role, deployment preference, what they are
 * worried about) belongs in the reply to people who raise their hand.
 */
export function WaitlistForm({ compact = false }: { compact?: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    setMessage("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, website }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setStatus("done");
    } catch {
      setStatus("error");
      setMessage("Network error. Please try again.");
    }
  }

  if (status === "done") {
    return (
      <div
        role="status"
        className="mx-auto flex max-w-md items-start gap-3 rounded-xl border border-primer-green/30 bg-primer-green/5 p-5 text-left"
      >
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primer-green" />
        <div>
          <p className="text-sm font-semibold text-fg-primary">
            You&rsquo;re on the list.
          </p>
          <p className="mt-1 text-sm leading-relaxed text-primer-muted">
            We&rsquo;ll be in touch about pilot conversations. If you have a
            specific worry about your own stack, reply to that email with it
            &mdash; it&rsquo;s the most useful thing you can send us.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className={`mx-auto w-full ${compact ? "max-w-md" : "max-w-lg"} text-left`}
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="sr-only" htmlFor="wl-name">
          Name
        </label>
        <input
          id="wl-name"
          name="name"
          type="text"
          required
          maxLength={100}
          autoComplete="name"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-border-default bg-surface-card px-4 py-3 text-sm text-fg-primary placeholder:text-primer-muted focus:border-primer-green focus:outline-none"
        />
        <label className="sr-only" htmlFor="wl-email">
          Work email
        </label>
        <input
          id="wl-email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          placeholder="Work email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-border-default bg-surface-card px-4 py-3 text-sm text-fg-primary placeholder:text-primer-muted focus:border-primer-green focus:outline-none"
        />
      </div>

      {/* Honeypot. Hidden from people, irresistible to bots. Not `display:none`,
          which some bots skip — off-screen with aria-hidden and no tab stop. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-[-9999px]">
        <label htmlFor="wl-website">Website</label>
        <input
          id="wl-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      <button
        type="submit"
        disabled={status === "submitting"}
        className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-primer-green px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "submitting" ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Joining&hellip;
          </>
        ) : (
          <>
            Join the waitlist
            <ArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </button>

      {status === "error" && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {message}
        </p>
      )}

      <p className="mt-3 text-xs leading-relaxed text-primer-muted">
        Name and email only. We&rsquo;ll use it to talk to you about the pilot,
        nothing else.
      </p>
    </form>
  );
}
