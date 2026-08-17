"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Lock } from "lucide-react";

interface InstallationSettings {
  severityThreshold: "Low" | "Med" | "High";
  commentTypes: { syntax: boolean; logic: boolean; style: boolean };
  maxComments: number;
  summary: {
    prSummary: boolean;
    confidenceScore: boolean;
    issuesTable: boolean;
    diagram: boolean;
  };
  customInstructions: string;
  commentHeader: string;
}

const DEFAULT_SETTINGS: InstallationSettings = {
  // #357 — 'Low' reports every tier; saving untouched settings must not
  // silently opt an installation into info-suppression.
  severityThreshold: "Low",
  commentTypes: { syntax: true, logic: true, style: true },
  maxComments: 10,
  summary: {
    prSummary: true,
    confidenceScore: true,
    issuesTable: true,
    diagram: true,
  },
  customInstructions: "",
  commentHeader: "",
};

interface SettingsFormProps {
  installationId: string;
  isAdmin: boolean;
  accountLogin: string;
  accountType: "User" | "Organization";
}

function cn(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function Toggle({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      disabled={disabled}
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={cn(
        "flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors",
        !disabled && "hover:bg-hover active:bg-[rgba(255,255,255,0.05)]",
        "disabled:opacity-40 disabled:cursor-not-allowed"
      )}
    >
      <div className="mr-4">
        <div className="text-sm text-fg-primary">{label}</div>
        <div className="text-xs text-fg-tertiary mt-0.5">{description}</div>
      </div>
      <div
        className={cn(
          "relative w-11 h-6 shrink-0 rounded-full transition-colors duration-200",
          value ? "bg-[#00ff88]" : "bg-surface-subtle"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-black transition-transform duration-200",
            value && "translate-x-5"
          )}
        />
      </div>
    </button>
  );
}

export default function SettingsForm({
  installationId,
  isAdmin,
  accountLogin,
  accountType,
}: SettingsFormProps) {
  const [settings, setSettings] = useState<InstallationSettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<InstallationSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/settings?installation_id=${installationId}`
        );
        if (res.ok) {
          const data = await res.json();
          setSettings(data.settings);
          setSavedSettings(data.settings);
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [installationId]);

  const isDirty = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [settings, savedSettings]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      const res = await fetch(
        `/api/settings?installation_id=${installationId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings }),
        }
      );
      if (res.ok) {
        setSavedSettings(settings);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  }, [installationId, settings]);

  if (loading) {
    return (
      <div>
        {/* Header skeleton */}
        <div className="px-4 pt-6 pb-5 border-b border-border-default sm:px-8 sm:pt-8 sm:pb-6">
          <div className="h-6 w-28 animate-pulse rounded bg-surface-subtle" />
          <div className="mt-2 h-4 w-72 animate-pulse rounded bg-surface-subtle" />
        </div>

        {/* Settings sections skeleton */}
        <div className="px-4 sm:px-8 pb-6">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="mt-8">
              <div className="h-3 w-24 animate-pulse rounded bg-surface-subtle mb-4" />
              <div className="rounded-lg border border-border-default overflow-hidden">
                {[...Array(3)].map((_, j) => (
                  <div key={j} className="flex items-center justify-between px-4 py-4 border-b border-border-subtle last:border-0">
                    <div>
                      <div className="h-4 w-36 animate-pulse rounded bg-surface-subtle" />
                      <div className="mt-1.5 h-3 w-52 animate-pulse rounded bg-surface-subtle" />
                    </div>
                    <div className="h-6 w-11 animate-pulse rounded-full bg-surface-subtle" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const disabled = !isAdmin;

  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-6 pb-5 border-b border-border-default sm:px-8 sm:pt-8 sm:pb-6">
        <h1 className="text-fg-primary text-xl font-semibold">Settings</h1>
        <p className="text-fg-tertiary text-sm mt-1">
          Default behavior for all connected repos. Per-repo overrides via{" "}
          <code className="text-xs text-fg-secondary bg-surface-subtle px-1 py-0.5 rounded">
            .mergewatch.yml
          </code>
        </p>
      </div>

      <div className="px-4 sm:px-8 pb-6">
      {/* Read-only banner */}
      {!isAdmin && (
        <div className="flex items-center gap-2 px-4 py-2.5 mt-6 bg-surface-subtle border border-surface-subtle rounded-lg text-fg-secondary text-sm">
          <Lock size={13} className="shrink-0" />
          <span>
            Settings can only be changed by{" "}
            {accountType === "Organization" ? "org owners" : "the account owner"}.
            {accountType === "Organization" && (
              <>
                {" "}
                Manage roles in{" "}
                <a
                  href={`https://github.com/orgs/${accountLogin}/people`}
                  target="_blank"
                  className="text-accent-green hover:underline"
                >
                  GitHub
                </a>
                .
              </>
            )}
          </span>
        </div>
      )}

      {/* Section 1: Comments */}
      <section className="mt-8">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted pb-2 border-b border-border-default">
          Comments
        </h2>

        <div className="mt-3 rounded-lg border border-border-default divide-y divide-border-subtle overflow-hidden">
          {/* Severity Threshold */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3.5 gap-2">
            <div>
              <div className="text-sm text-fg-primary">Severity threshold</div>
              <div className="text-xs text-fg-tertiary mt-0.5">
                Minimum severity level to include in reviews
              </div>
            </div>
            <div className="flex rounded-md border border-surface-subtle overflow-hidden w-fit">
              {(["Low", "Med", "High"] as const).map((level) => (
                <button
                  key={level}
                  disabled={disabled}
                  onClick={() =>
                    setSettings((s) => ({ ...s, severityThreshold: level }))
                  }
                  className={cn(
                    "px-4 py-1.5 text-sm transition-colors",
                    settings.severityThreshold === level
                      ? "bg-[#00ff88] text-black font-medium"
                      : "text-fg-secondary hover:text-fg-primary",
                    "disabled:opacity-40 disabled:cursor-not-allowed"
                  )}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          {/* Comment Types */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3.5 gap-2">
            <div>
              <div className="text-sm text-fg-primary">Comment types</div>
              <div className="text-xs text-fg-tertiary mt-0.5">
                Categories of issues to flag
              </div>
            </div>
            <div className="flex gap-4">
              {(["syntax", "logic", "style"] as const).map((type) => (
                <label
                  key={type}
                  className={cn(
                    "flex items-center gap-2 cursor-pointer select-none rounded-md px-3 py-1.5 transition-colors",
                    settings.commentTypes[type]
                      ? "bg-[#00ff88]/10 text-accent-green"
                      : "text-fg-tertiary",
                    !disabled && "hover:bg-hover",
                    disabled && "opacity-40 cursor-not-allowed"
                  )}
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={settings.commentTypes[type]}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        commentTypes: {
                          ...s.commentTypes,
                          [type]: e.target.checked,
                        },
                      }))
                    }
                    className="sr-only"
                  />
                  <span className="text-sm font-medium capitalize">{type}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Max Comments */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3.5 gap-2">
            <div>
              <div className="text-sm text-fg-primary">Max comments per review</div>
              <div className="text-xs text-fg-tertiary mt-0.5">
                Limit the number of findings posted (1–50)
              </div>
            </div>
            <input
              type="number"
              min={1}
              max={50}
              disabled={disabled}
              value={settings.maxComments}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  maxComments: Math.max(1, Math.min(50, Number(e.target.value))),
                }))
              }
              className="w-20 bg-surface-card-hover border border-surface-subtle rounded px-3 py-1.5 text-sm text-fg-primary text-center disabled:opacity-40 disabled:cursor-not-allowed"
            />
          </div>
        </div>
      </section>

      {/* Section 2: PR Summary */}
      <section className="mt-8">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted pb-2 border-b border-border-default">
          PR Summary
        </h2>
        <div className="mt-3 divide-y divide-border-subtle rounded-lg border border-border-default overflow-hidden">
          <Toggle
            label="PR Summary"
            description="Plain-language description of what changed"
            value={settings.summary.prSummary}
            onChange={(v) =>
              setSettings((s) => ({
                ...s,
                summary: { ...s.summary, prSummary: v },
              }))
            }
            disabled={disabled}
          />
          <Toggle
            label="Confidence Score"
            description="How confident agents are in their findings"
            value={settings.summary.confidenceScore}
            onChange={(v) =>
              setSettings((s) => ({
                ...s,
                summary: { ...s.summary, confidenceScore: v },
              }))
            }
            disabled={disabled}
          />
          <Toggle
            label="Issues Table"
            description="Structured table of flagged issues"
            value={settings.summary.issuesTable}
            onChange={(v) =>
              setSettings((s) => ({
                ...s,
                summary: { ...s.summary, issuesTable: v },
              }))
            }
            disabled={disabled}
          />
          <Toggle
            label="Diagram"
            description="Sequence/architecture diagram of changes"
            value={settings.summary.diagram}
            onChange={(v) =>
              setSettings((s) => ({
                ...s,
                summary: { ...s.summary, diagram: v },
              }))
            }
            disabled={disabled}
          />
        </div>
      </section>

      {/* Section 3: Custom Instructions */}
      <section className="mt-8">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted pb-2 border-b border-border-default">
          Custom Instructions
        </h2>
        <div className="mt-4">
          <textarea
            disabled={disabled}
            value={settings.customInstructions}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                customInstructions: e.target.value.slice(0, 1000),
              }))
            }
            placeholder="e.g. This is a TypeScript codebase. Flag any use of 'any' type. We follow the Airbnb style guide."
            rows={4}
            className="w-full bg-surface-card-hover border border-surface-subtle rounded-md px-3 py-2.5 text-sm text-fg-primary placeholder-fg-muted resize-y focus:outline-none focus:border-[#00ff88]/40 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <div className="mt-1 text-right text-xs text-fg-muted">
            {settings.customInstructions.length}/1000
          </div>
        </div>
      </section>

      {/* Section 4: Comment Header */}
      <section className="mt-8">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-fg-muted pb-2 border-b border-border-default">
          Comment Header
        </h2>
        <div className="mt-4">
          <input
            type="text"
            disabled={disabled}
            value={settings.commentHeader}
            onChange={(e) =>
              setSettings((s) => ({ ...s, commentHeader: e.target.value }))
            }
            placeholder="e.g. Review generated by MergeWatch"
            className="w-full bg-surface-card-hover border border-surface-subtle rounded-md px-3 py-2 text-sm text-fg-primary placeholder-fg-muted focus:outline-none focus:border-[#00ff88]/40 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          {/* Live preview */}
          {settings.commentHeader && (
            <div className="mt-3 rounded-md border border-surface-subtle bg-surface-inset px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1.5">
                Preview
              </div>
              <div
                className="text-sm text-fg-secondary prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: settings.commentHeader
                    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
                    .replace(
                      /\[([^\]]+)\]\(([^)]+)\)/g,
                      '<a href="$2" class="text-accent-green hover:underline">$1</a>'
                    )
                    .replace(/^>\s*/, ""),
                }}
              />
            </div>
          )}
        </div>
      </section>

      {/* Save Button */}
      {isAdmin && (
        <div className="flex items-center justify-end gap-3 pt-6 border-t border-border-default mt-8">
          {saveSuccess && (
            <span className="text-sm text-accent-green">Settings saved</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className={cn(
              "px-4 py-2 rounded-md text-sm font-medium transition-colors",
              isDirty
                ? "bg-[#00ff88] text-black hover:bg-[#00e67a]"
                : "bg-surface-subtle text-fg-muted cursor-not-allowed"
            )}
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
