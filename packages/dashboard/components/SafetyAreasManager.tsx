"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { OrgSafetyArea } from "@mergewatch/core";

interface Props {
  installationId: string;
  isAdmin: boolean;
  repos: string[];
}

function blankArea(): OrgSafetyArea {
  return {
    id: "",
    name: "",
    patterns: [],
    notes: "",
    enabled: true,
    scope: { mode: "all" },
    updatedAt: "",
    updatedBy: "",
  };
}

/** Drop empty optional fields so the server sees exactly what the admin set. */
function toPayload(a: OrgSafetyArea): OrgSafetyArea {
  const { name, patterns, notes, level, ...rest } = a;
  return {
    ...rest,
    ...(name?.trim() ? { name: name.trim() } : {}),
    ...(patterns && patterns.length ? { patterns } : {}),
    ...(notes?.trim() ? { notes: notes.trim() } : {}),
    ...(level ? { level } : {}),
  };
}

/**
 * #718 — org admins define safety areas that apply to every in-scope repo's
 * safety score, in union with each repo's own `.mergewatch.yml` areas.
 */
export default function SafetyAreasManager({ installationId, isAdmin, repos }: Props) {
  const [areas, setAreas] = useState<OrgSafetyArea[]>([]);
  const [cap, setCap] = useState(50);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/safety-areas?installation_id=${installationId}`);
        if (res.status === 401) { window.location.href = "/signout"; return; }
        if (!res.ok) throw new Error("Failed to load safety areas");
        const json = await res.json();
        if (!cancelled) {
          setAreas(json.areas ?? []);
          setCap(json.cap ?? 50);
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [installationId]);

  function update(i: number, patch: Partial<OrgSafetyArea>) {
    setAreas((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
    setSavedAt(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/safety-areas?installation_id=${installationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areas: areas.map(toPayload) }),
      });
      if (res.status === 401) { window.location.href = "/signout"; return; }
      if (res.status === 403) throw new Error("Only org admins can edit safety areas.");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to save");
      const json = await res.json();
      setAreas(json.areas ?? areas);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-6 sm:px-8">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-subtle" />
        <div className="mt-4 h-40 animate-pulse rounded-lg bg-surface-subtle" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 sm:px-8">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-fg-primary">Safety Areas</h1>
        <p className="mt-1 text-sm text-fg-secondary">
          Org-wide areas for the advisory safety score. They apply in addition to each
          repo&apos;s own <code>safetyScore.areas</code>, and the riskiest matching level wins, so a
          repo can add areas but never weaken one defined here. An area needs file patterns, or
          a name and notes for the reviewer to judge. Applies only where the safety score is on.
        </p>
      </header>

      {!isAdmin && (
        <div className="mb-4 rounded-md border border-border-default bg-surface-subtle p-3 text-sm text-fg-secondary">
          You have read-only access. Only organization admins can add or edit safety areas.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {areas.length === 0 && (
          <div className="rounded-lg border border-border-default bg-surface-card p-8 text-center text-sm text-fg-secondary">
            No safety areas yet.{isAdmin ? " Add one to mark what is risky across your org." : ""}
          </div>
        )}
        {areas.map((a, i) => (
          <AreaCard
            key={a.id || `new-${i}`}
            area={a}
            repos={repos}
            disabled={!isAdmin}
            onChange={(patch) => update(i, patch)}
            onRemove={() => { setAreas((prev) => prev.filter((_, idx) => idx !== i)); setSavedAt(null); }}
          />
        ))}
      </div>

      {isAdmin && (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => { setAreas((prev) => [...prev, blankArea()]); setSavedAt(null); }}
            disabled={areas.length >= cap}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-default bg-surface-card px-3 py-1.5 text-sm text-fg-primary transition hover:bg-hover disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Add area
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent-emphasis px-4 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          <span className="text-xs text-fg-tertiary">{areas.length} / {cap}</span>
          {savedAt && <span className="text-xs text-fg-tertiary">Saved at {savedAt}</span>}
        </div>
      )}
    </div>
  );
}

function AreaCard({
  area,
  repos,
  disabled,
  onChange,
  onRemove,
}: {
  area: OrgSafetyArea;
  repos: string[];
  disabled: boolean;
  onChange: (patch: Partial<OrgSafetyArea>) => void;
  onRemove: () => void;
}) {
  const inputCls =
    "rounded-md border border-border-default bg-surface-card px-2 py-1.5 text-sm text-fg-primary focus:border-accent-emphasis focus:outline-none focus:ring-1 focus:ring-accent-emphasis disabled:opacity-60";
  const selectedRepos = area.scope.mode === "selected" ? area.scope.repos : [];

  function toggleRepo(repo: string) {
    const set = new Set(selectedRepos);
    if (set.has(repo)) set.delete(repo); else set.add(repo);
    onChange({ scope: { mode: "selected", repos: Array.from(set) } });
  }

  return (
    <div className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <input
          className={`${inputCls} flex-1`}
          placeholder="Name (required without patterns), e.g. Message delivery"
          value={area.name ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {!disabled && (
          <button type="button" onClick={onRemove} className="p-1.5 text-fg-tertiary transition hover:text-red-500" aria-label="Remove area">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <label className="mt-3 block text-sm text-fg-secondary">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-fg-tertiary">File patterns (optional)</span>
        <input
          className={`${inputCls} w-full`}
          placeholder="services/notifications/**, **/migrations/**"
          disabled={disabled}
          value={(area.patterns ?? []).join(", ")}
          onChange={(e) => onChange({ patterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
        />
      </label>

      <textarea
        className={`${inputCls} mt-3 w-full`}
        rows={2}
        placeholder="Notes for the reviewer — why this area matters"
        value={area.notes ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ notes: e.target.value })}
      />

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-sm text-fg-secondary">
          Level
          <select
            className={inputCls}
            value={area.level ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ level: (e.target.value || undefined) as OrgSafetyArea["level"] })}
          >
            <option value="">No level (guidance only)</option>
            <option value="safe">Safe</option>
            <option value="caution">Caution</option>
            <option value="risky">Risky</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-fg-secondary">
          <input type="checkbox" checked={area.enabled} disabled={disabled}
            onChange={(e) => onChange({ enabled: e.target.checked })} />
          Enabled
        </label>
      </div>

      <div className="mt-3">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-fg-tertiary">Applies to</p>
        <div className="flex gap-4 text-sm text-fg-secondary">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={area.scope.mode === "all"} disabled={disabled}
              onChange={() => onChange({ scope: { mode: "all" } })} />
            All repositories
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={area.scope.mode === "selected"} disabled={disabled}
              onChange={() => onChange({ scope: { mode: "selected", repos: selectedRepos } })} />
            Selected repositories
          </label>
        </div>
        {area.scope.mode === "selected" && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-border-default p-2">
            {repos.length === 0 && <p className="px-1 py-2 text-xs text-fg-tertiary">No repositories.</p>}
            {repos.map((r) => (
              <label key={r} className="flex items-center gap-1.5 px-1 py-0.5 text-sm text-fg-primary">
                <input type="checkbox" checked={selectedRepos.includes(r)} disabled={disabled}
                  onChange={() => toggleRepo(r)} />
                {r}
              </label>
            ))}
          </div>
        )}
      </div>

      {area.updatedBy && (
        <p className="mt-3 text-xs text-fg-tertiary">
          Last edited by {area.updatedBy}
          {area.updatedAt ? ` · ${new Date(area.updatedAt).toLocaleString()}` : ""}
        </p>
      )}
    </div>
  );
}
