"use client";

import { useState, useEffect, useCallback } from "react";
import { CreditCard, Zap, TrendingUp, AlertCircle, CheckCircle2, Loader2, RefreshCw, HeartHandshake } from "lucide-react";

interface BillingStatus {
  freeReviewsUsed: number;
  freeReviewLimit: number;
  balanceCents: number;
  hasPaymentMethod: boolean;
  stripeCustomerId: string | null;
  autoReloadEnabled: boolean;
  autoReloadThresholdCents: number | null;
  autoReloadAmountCents: number | null;
  blockedAt: string | null;
  totalBilledCents: number;
  prCount: number;
  prTimestamps: string[];
  /**
   * OSS Program (#261, org scope #409). Null for every installation without a
   * grant. `active` is computed server-side so this panel can't drift from the
   * billing gate's own notion of an active grant.
   */
  oss: {
    active: boolean;
    /** 'org' sponsors every public repo in the installation; 'repos' only those named. */
    scope: "repos" | "org";
    account: { id: number; login: string } | null;
    /** Null under org scope — coverage is not a fixed list there. */
    repos: string[] | null;
    expiresAt: string;
    grantedAt: string | null;
    note: string | null;
    monthlyCapCents: number | null;
    sponsoredThisPeriodCents: number;
    sponsoredLifetimeCents: number;
  } | null;
}

interface BillingClientProps {
  installationId: string;
  accountLogin: string;
  setupComplete?: boolean;
}

function cn(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

const TOP_UP_AMOUNTS = [
  { label: "$10", cents: 1000 },
  { label: "$25", cents: 2500 },
  { label: "$50", cents: 5000 },
  { label: "$100", cents: 10000 },
];

export default function BillingClient({ installationId, accountLogin, setupComplete }: BillingClientProps) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topUpLoading, setTopUpLoading] = useState<number | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [showSetupBanner, setShowSetupBanner] = useState(setupComplete ?? false);
  const [autoReloadSaving, setAutoReloadSaving] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/billing/status?installation_id=${installationId}`);
      if (!res.ok) throw new Error("Failed to fetch billing status");
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSetup = async () => {
    setSetupLoading(true);
    try {
      const res = await fetch("/api/billing/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError("Failed to create setup session");
      }
    } catch {
      setError("Failed to start card setup");
    } finally {
      setSetupLoading(false);
    }
  };

  const handleTopUp = async (amountCents: number) => {
    setTopUpLoading(amountCents);
    try {
      const res = await fetch("/api/billing/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId, amountCents }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Top-up failed");
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Top-up failed");
    } finally {
      setTopUpLoading(null);
    }
  };

  const handleAutoReloadToggle = async () => {
    setAutoReloadSaving(true);
    try {
      const newEnabled = !status?.autoReloadEnabled;
      const res = await fetch("/api/billing/auto-reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId,
          enabled: newEnabled,
          // Default: reload $25 when balance drops below $5
          thresholdCents: newEnabled ? (status?.autoReloadThresholdCents ?? 500) : undefined,
          amountCents: newEnabled ? (status?.autoReloadAmountCents ?? 2500) : undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to update auto-reload");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update auto-reload");
    } finally {
      setAutoReloadSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-fg-faint" />
      </div>
    );
  }

  if (error && !status) {
    return (
      <div>
        <div className="px-4 pt-6 pb-5 border-b border-border-default sm:px-8 sm:pt-8 sm:pb-6">
          <h1 className="text-fg-primary text-xl font-semibold">Billing</h1>
          <p className="text-fg-tertiary text-sm mt-1">
            Manage credits and payment for <span className="text-fg-secondary">{accountLogin}</span>
          </p>
        </div>
        <div className="px-4 py-6 sm:px-8 sm:py-8">
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center">
            <AlertCircle className="mx-auto mb-2 h-6 w-6 text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!status) return null;

  const isFreeTier = status.freeReviewsUsed < status.freeReviewLimit;
  const balanceUsd = (status.balanceCents / 100).toFixed(2);
  const totalBilledUsd = (status.totalBilledCents / 100).toFixed(2);

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentTimestamps = status.prTimestamps.filter((t) => new Date(t).getTime() > thirtyDaysAgo);
  const reviewsPerDay = recentTimestamps.length > 0
    ? (recentTimestamps.length / 30).toFixed(1)
    : "0";

  const avgCostPerReview = status.prCount > 0 ? status.totalBilledCents / status.prCount : 0;
  const projectedMonthlyCents = parseFloat(reviewsPerDay) * 30 * avgCostPerReview;
  const projectedMonthlyUsd = (projectedMonthlyCents / 100).toFixed(2);

  const dailyCostCents = parseFloat(reviewsPerDay) * avgCostPerReview;
  const balanceDays = dailyCostCents > 0 && isFinite(dailyCostCents) ? Math.floor(status.balanceCents / dailyCostCents) : null;

  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-6 pb-5 border-b border-border-default sm:px-8 sm:pt-8 sm:pb-6">
        <h1 className="text-fg-primary text-xl font-semibold">Billing</h1>
        <p className="text-fg-tertiary text-sm mt-1">
          Manage credits and payment for <span className="text-fg-secondary">{accountLogin}</span>
        </p>
      </div>

      {/* Content */}
      <div className="px-4 py-6 sm:px-8 sm:py-8 space-y-6">
        {/* Setup complete banner */}
        {showSetupBanner && (
          <div className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3">
            <CheckCircle2 className="h-5 w-5 text-green-400 shrink-0" />
            <p className="text-sm text-green-300">Payment method added successfully.</p>
            <button
              onClick={() => setShowSetupBanner(false)}
              className="ml-auto text-xs text-fg-tertiary hover:text-fg-secondary"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
            <AlertCircle className="h-5 w-5 text-red-400 shrink-0" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-xs text-fg-tertiary hover:text-fg-secondary"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* OSS Program (#261) — sponsored reviews.
            Rendered alongside the credit balance rather than replacing it:
            a granted installation can still contain private or unnamed repos
            that bill normally, so both states are true at once. */}
        {status.oss && (
          <div className="rounded-lg border border-border-default bg-surface-card p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <HeartHandshake className="h-4 w-4 text-accent-green" />
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted">
                Open Source Program
              </h2>
              {!status.oss.active && (
                <span className="ml-auto rounded-full border border-yellow-500/30 bg-yellow-500/5 px-2 py-0.5 text-[10px] font-medium text-yellow-300">
                  Expired
                </span>
              )}
            </div>

            {status.oss.active ? (
              <p className="text-sm text-fg-secondary">
                {status.oss.scope === "org" ? (
                  <>
                    Every public repository in this organization is sponsored by MergeWatch — no
                    charge, and sponsored reviews don&rsquo;t use your free reviews or balance.
                  </>
                ) : (
                  <>
                    Reviews on the repositories below are sponsored by MergeWatch — no charge, and
                    they don&rsquo;t use your free reviews or balance.
                  </>
                )}
              </p>
            ) : (
              <p className="text-sm text-fg-secondary">
                This grant expired on {new Date(status.oss.expiresAt).toLocaleDateString()}. Reviews
                now fall back to your free tier and balance. Get in touch at{" "}
                <a
                  href="https://mergewatch.ai/open-source"
                  className="text-accent-green hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  mergewatch.ai/open-source
                </a>{" "}
                to renew it — there&rsquo;s no charge.
              </p>
            )}

            <div className="mt-5 grid gap-5 sm:grid-cols-3">
              <div>
                <div className="text-2xl font-bold text-fg-primary tabular-nums">
                  ${(status.oss.sponsoredThisPeriodCents / 100).toFixed(2)}
                </div>
                <p className="mt-1 text-xs text-fg-tertiary">Sponsored this month</p>
                {status.oss.monthlyCapCents !== null && (
                  <>
                    <div className="mt-2 h-2 rounded-full bg-surface-card-hover">
                      <div
                        className="h-2 rounded-full bg-accent-green transition-all"
                        style={{
                          // A zero cap means no allowance at all, so the bar is
                          // full. Guarding the divide matters: 0/0 is NaN, which
                          // renders as `width: "NaN%"` and silently drops the bar.
                          width: `${status.oss.monthlyCapCents > 0
                            ? Math.min(100, (status.oss.sponsoredThisPeriodCents / status.oss.monthlyCapCents) * 100)
                            : 100}%`,
                        }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-fg-muted">
                      of ${(status.oss.monthlyCapCents / 100).toFixed(2)} fair-use limit
                    </p>
                  </>
                )}
              </div>

              <div>
                <div className="text-2xl font-bold text-fg-primary tabular-nums">
                  ${(status.oss.sponsoredLifetimeCents / 100).toFixed(2)}
                </div>
                <p className="mt-1 text-xs text-fg-tertiary">Sponsored to date</p>
              </div>

              <div>
                <div className="text-2xl font-bold text-fg-primary tabular-nums">
                  {status.oss.scope === "org" ? "All" : status.oss.repos?.length ?? 0}
                </div>
                <p className="mt-1 text-xs text-fg-tertiary">
                  {status.oss.scope === "org"
                    ? "Public repositories"
                    : status.oss.repos?.length === 1
                      ? "Covered repository"
                      : "Covered repositories"}
                </p>
              </div>
            </div>

            <div className="mt-5 pt-4 border-t border-border-default">
              {status.oss.scope === "org" ? (
                <>
                  <p className="text-xs text-fg-tertiary mb-2">
                    Coverage
                    {status.oss.account ? ` — ${status.oss.account.login}` : ""}
                  </p>
                  <p className="text-sm text-fg-secondary">
                    Every public repository, including ones you create later.
                  </p>
                  <p className="mt-3 text-[11px] text-fg-muted">
                    Private repositories are never sponsored and bill normally — and a repository
                    switched to private stops being sponsored on its next review.
                    {status.oss.active && ` Grant runs until ${new Date(status.oss.expiresAt).toLocaleDateString()}.`}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-fg-tertiary mb-2">Covered repositories</p>
                  <ul className="space-y-1">
                    {(status.oss.repos ?? []).map((r) => (
                      <li key={r} className="text-sm text-fg-secondary">{r}</li>
                    ))}
                  </ul>
                  <p className="mt-3 text-[11px] text-fg-muted">
                    Only these repositories are sponsored, and only while they are public. Anything
                    else in this installation bills normally.
                    {status.oss.active && ` Grant runs until ${new Date(status.oss.expiresAt).toLocaleDateString()}.`}
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        {/* Blocked banner */}
        {status.blockedAt && (
          <div className="flex items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-4 py-3">
            <AlertCircle className="h-5 w-5 text-yellow-400 shrink-0" />
            <p className="text-sm text-yellow-300">
              Reviews are paused — add credits below to resume.
            </p>
          </div>
        )}

        {/* Cards grid */}
        <div className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-2">
          {/* Credit Balance */}
          <div className="rounded-lg border border-border-default bg-surface-card p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <Zap className="h-4 w-4 text-accent-green" />
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted">Credit Balance</h2>
            </div>

            {isFreeTier ? (
              <div>
                <div className="text-3xl font-bold text-fg-primary tabular-nums">
                  {status.freeReviewLimit - status.freeReviewsUsed}
                  <span className="text-lg font-normal text-fg-tertiary"> / {status.freeReviewLimit} free</span>
                </div>
                <p className="mt-1 text-xs text-fg-tertiary">Free reviews remaining</p>
                <div className="mt-3 h-2 rounded-full bg-surface-card-hover">
                  <div
                    className="h-2 rounded-full bg-accent-green transition-all"
                    style={{ width: `${(status.freeReviewsUsed / status.freeReviewLimit) * 100}%` }}
                  />
                </div>
              </div>
            ) : (
              <div>
                <div className="text-3xl font-bold text-fg-primary tabular-nums">
                  ${balanceUsd}
                </div>
                <p className="mt-1 text-xs text-fg-tertiary">
                  {balanceDays !== null ? `~${balanceDays} days at current pace` : "Prepaid credit balance"}
                </p>
              </div>
            )}

            {/* Top-up buttons */}
            {status.hasPaymentMethod && (
              <div className="mt-5 pt-4 border-t border-border-default">
                <p className="text-xs text-fg-tertiary mb-2">Add credits</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {TOP_UP_AMOUNTS.map(({ label, cents }) => (
                    <button
                      key={cents}
                      onClick={() => handleTopUp(cents)}
                      disabled={topUpLoading !== null}
                      className={cn(
                        "rounded-md border border-border-default px-3 py-2 text-sm font-medium transition",
                        "hover:border-accent-green hover:text-accent-green",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        topUpLoading === cents && "border-accent-green text-accent-green",
                      )}
                    >
                      {topUpLoading === cents ? (
                        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                      ) : (
                        label
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Usage Summary */}
          <div className="rounded-lg border border-border-default bg-surface-card p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="h-4 w-4 text-accent-green" />
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted">Usage</h2>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm text-fg-tertiary">Reviews (total)</span>
                <span className="text-sm font-medium text-fg-primary tabular-nums">{status.prCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-fg-tertiary">Total billed</span>
                <span className="text-sm font-medium text-fg-primary tabular-nums">${totalBilledUsd}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-fg-tertiary">Avg cost / review</span>
                <span className="text-sm font-medium text-fg-primary tabular-nums">
                  ${status.prCount > 0 ? (avgCostPerReview / 100).toFixed(3) : "0.000"}
                </span>
              </div>

              <div className="pt-3 border-t border-border-default">
                <div className="flex justify-between">
                  <span className="text-sm text-fg-tertiary">Reviews / day (30d)</span>
                  <span className="text-sm font-medium text-fg-primary tabular-nums">{reviewsPerDay}</span>
                </div>
                <div className="flex justify-between mt-2">
                  <span className="text-sm text-fg-tertiary">Projected monthly</span>
                  <span className="text-sm font-medium text-fg-primary tabular-nums">${projectedMonthlyUsd}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Payment Method */}
        <div className="rounded-lg border border-border-default bg-surface-card p-5 sm:p-6">
          <div className="flex items-center gap-2 mb-4">
            <CreditCard className="h-4 w-4 text-accent-green" />
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted">Payment Method</h2>
          </div>

          {status.hasPaymentMethod ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-400" />
                <span className="text-sm text-fg-secondary">Card on file</span>
              </div>
              <button
                onClick={handleSetup}
                disabled={setupLoading}
                className="text-xs text-fg-tertiary hover:text-fg-secondary transition"
              >
                {setupLoading ? "Loading..." : "Update card"}
              </button>
            </div>
          ) : (
            <div>
              <p className="text-sm text-fg-tertiary mb-3">
                Add a payment method to purchase credits and keep reviews running after your free tier.
              </p>
              <button
                onClick={handleSetup}
                disabled={setupLoading}
                className={cn(
                  "rounded-md bg-accent-green px-4 py-2 text-sm font-medium text-black transition",
                  "hover:bg-[#00e67a] disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                {setupLoading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Setting up...
                  </span>
                ) : (
                  "Add payment method"
                )}
              </button>
            </div>
          )}
        </div>

        {/* Auto-Reload */}
        {status.hasPaymentMethod && (
          <div className="rounded-lg border border-border-default bg-surface-card p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <RefreshCw className="h-4 w-4 text-accent-green" />
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted">Auto-Reload</h2>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-fg-secondary">
                  Automatically add credits when balance is low
                </p>
                {status.autoReloadEnabled && (
                  <p className="text-xs text-fg-tertiary mt-1">
                    Reload ${((status.autoReloadAmountCents ?? 2500) / 100).toFixed(0)} when balance drops below ${((status.autoReloadThresholdCents ?? 500) / 100).toFixed(2)}
                  </p>
                )}
              </div>
              <button
                onClick={handleAutoReloadToggle}
                disabled={autoReloadSaving}
                className={cn(
                  "relative w-11 h-6 shrink-0 rounded-full transition-colors duration-200",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  status.autoReloadEnabled ? "bg-accent-green" : "bg-surface-card-hover",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200",
                    status.autoReloadEnabled && "translate-x-5",
                  )}
                />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
