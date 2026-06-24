"use client";

/**
 * #195 Phase 5 — throttled NPS survey prompt.
 *
 * On mount, asks `/api/nps?installation_id=…` whether this admin is eligible
 * (no response in the last 90 days, satisfaction store wired). If so, renders
 * a 0–10 likelihood-to-recommend scale; a click POSTs the score and shows a
 * brief thank-you. The 90-day throttle is enforced server-side; a per-browser
 * dismissal (sessionStorage) keeps a dismissed prompt from reappearing on
 * navigation within the same session.
 */

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type Phase = "hidden" | "asking" | "thanks";

export default function NpsPrompt({ installationId }: { installationId: string }) {
  const [phase, setPhase] = useState<Phase>("hidden");
  const [submitting, setSubmitting] = useState(false);
  const dismissKey = `mw-nps-dismissed-${installationId}`;

  useEffect(() => {
    let cancelled = false;
    // Respect an in-session dismissal without a network round-trip.
    if (typeof window !== "undefined" && window.sessionStorage.getItem(dismissKey)) {
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/api/nps?installation_id=${encodeURIComponent(installationId)}`);
        if (!r.ok) return;
        const data = (await r.json()) as { eligible?: boolean };
        if (!cancelled && data.eligible) setPhase("asking");
      } catch {
        // Network failure — stay hidden; the survey is non-critical.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installationId, dismissKey]);

  function dismiss() {
    if (typeof window !== "undefined") window.sessionStorage.setItem(dismissKey, "1");
    setPhase("hidden");
  }

  async function submit(score: number) {
    setSubmitting(true);
    try {
      await fetch("/api/nps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installation_id: installationId, score }),
      });
    } catch {
      // Best-effort — even on failure we thank the user and stop prompting.
    } finally {
      if (typeof window !== "undefined") window.sessionStorage.setItem(dismissKey, "1");
      setSubmitting(false);
      setPhase("thanks");
    }
  }

  if (phase === "hidden") return null;

  return (
    <section className="relative rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss survey"
        className="absolute right-3 top-3 text-text-secondary hover:text-text-primary"
      >
        <X size={16} />
      </button>

      {phase === "thanks" ? (
        <p className="text-sm text-text-primary">Thanks for the feedback! 🙏</p>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-text-primary">
            How likely are you to recommend MergeWatch to a colleague?
          </h2>
          <p className="mt-1 text-xs text-text-secondary">0 = not at all · 10 = extremely likely</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {Array.from({ length: 11 }, (_, n) => (
              <button
                key={n}
                type="button"
                disabled={submitting}
                onClick={() => submit(n)}
                className="h-9 w-9 rounded-md border border-border-default text-sm font-medium text-text-primary tabular-nums transition-colors hover:border-accent-green hover:bg-accent-green hover:text-white disabled:opacity-50"
              >
                {n}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
